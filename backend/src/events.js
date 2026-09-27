// Central internal event bus. All modules publish here.
// v1 channels: IN_APP + EMAIL (SMTP when configured, console stub otherwise).
// SMS sends for real when SMS_WEBHOOK_URL is set, else PENDING_STUB.
// WhatsApp has log tables and a clean interface for later.
const db = require('./db');

const smsProviders = {
  // Generic HTTP SMS seam. Set SMS_WEBHOOK_URL (and optional SMS_WEBHOOK_KEY)
  // to a gateway that accepts POST {to, message} and returns 2xx.
  // Twilio, Gupshup, or any bulk SMS vendor fits behind this function.
  // With no webhook configured it throws, and callers record PENDING_STUB.
  sendSms: async (mobile, message) => {
    const url = process.env.SMS_WEBHOOK_URL;
    if (!url) throw new Error('SMS_WEBHOOK_URL is not configured');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SMS_WEBHOOK_KEY ? { Authorization: 'Bearer ' + process.env.SMS_WEBHOOK_KEY } : {}),
      },
      body: JSON.stringify({ to: mobile, message }),
    });
    if (!r.ok) throw new Error('SMS gateway returned HTTP ' + r.status);
    return { status: 'SENT', mobile };
  },
};
const whatsappProviders = {
  sendWhatsapp: async (mobile, message) => ({ status: 'QUEUED_STUB', mobile }),
};

function renderTemplate(tpl, vars) {
  let out = tpl || '';
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split('{{' + k + '}}').join(String(v == null ? '' : v));
  }
  return out;
}

async function logEmail(notificationId, address, subject, status, response) {
  await db.prepare(`INSERT INTO email_logs (notification_id, email_address, subject, status, response, sent_at)
    VALUES (?,?,?,?,?,datetime('now'))`).run(notificationId, address, subject, status, response);
}

// Real SMTP transport. Configure via SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, SMTP_FROM. When unset, v1 falls back to console logging so
// demos work with zero setup, and the fallback is recorded in email_logs.
let transporter = null;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    });
  }
  return transporter;
}

async function sendEmail(address, subject, message) {
  // HTTP providers first: they use port 443, which free hosts never block,
  // unlike outbound SMTP (port 587), which many free tiers block entirely.
  if (process.env.BREVO_API_KEY) {
    try {
      const id = await sendViaBrevo(address, subject, message);
      return { status: 'SENT', detail: `brevo=${id}` };
    } catch (e) {
      return { status: 'FAILED', detail: e.message };
    }
  }
  const tx = getTransport();
  if (!tx) {
    console.log(`[EMAIL-STUB] to=${address} subject=${subject} msg=${message}`);
    return { status: 'STUB_CONSOLE', detail: 'SMTP not configured; logged only' };
  }
  try {
    const info = await tx.sendMail({ from: process.env.SMTP_FROM || 'Rent Ledger <no-reply@localhost>', to: address, subject, text: message });
    return { status: 'SENT', detail: `messageId=${info.messageId}` };
  } catch (e) {
    return { status: 'FAILED', detail: e.message };
  }
}

// Brevo transactional HTTP API (free 300/day). Verify one sender address
// (even a Gmail) in the Brevo dashboard, create an API key, and set
// BREVO_API_KEY plus BREVO_SENDER. No domain or SMTP ports needed.
async function sendViaBrevo(address, subject, message) {
  let sender = process.env.BREVO_SENDER || '';
  if (!sender && process.env.SMTP_FROM) {
    const m = String(process.env.SMTP_FROM).match(/<(.*)>/);
    sender = m ? m[1] : process.env.SMTP_FROM;
  }
  if (!sender) throw new Error('BREVO_SENDER is not set (verify a sender in Brevo first)');
  const r = await fetch('https://api.smtp.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: sender, name: 'Rent Ledger' },
      to: [{ email: address }],
      subject,
      textContent: message,
    }),
  });
  if (!r.ok) throw new Error(`Brevo HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json().catch(() => ({}));
  return j.messageId || 'accepted';
}

async function dispatch({ eventCode, tenantId = null, userId = null, vars = {} }) {
  const templates = await db.prepare(
    `SELECT * FROM notification_templates WHERE event_code = ? AND status = 'ACTIVE'`).all(eventCode);
  // Always create at least an IN_APP notification even without template.
  const targets = templates.length ? templates : [{ channel: 'IN_APP', subject: null, message_template: eventCode, template_id: null }];
  const results = [];
  for (const t of targets) {
    const message = renderTemplate(t.message_template || eventCode, vars);
    const subject = t.subject ? renderTemplate(t.subject, vars) : eventCode;
    const recipient = vars.email || vars.mobile || null;
    const channel = t.channel || 'IN_APP';
    let status = 'SENT';
    let sentAt = new Date().toISOString();
    if (channel === 'EMAIL') {
      status = 'PENDING';
      sentAt = null;
    } else if (channel === 'IN_APP') {
      status = 'DELIVERED';
    } else {
      // SMS/WHATSAPP only leave stub rows unless the SMS seam is configured.
      status = 'PENDING';
      sentAt = null;
    }
    const info = await db.prepare(`INSERT INTO notifications
      (tenant_id, user_id, template_id, event_code, channel, recipient, subject, message, status, sent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, userId, t.template_id || null, eventCode, channel, recipient, subject, message, status, sentAt);
    const nid = info.lastInsertRowid;
    if (channel === 'EMAIL') {
      if (!recipient || !String(recipient).includes('@')) {
        await logEmail(nid, recipient, subject, 'FAILED', 'no email address on tenant record');
      } else {
        const out = await sendEmail(recipient, subject, message);
        // notifications.status is CHECK-constrained; STUB_CONSOLE lives only
        // in email_logs, while the notification itself stays PENDING.
        const nStatus = out.status === 'SENT' ? 'SENT' : (out.status === 'FAILED' ? 'FAILED' : 'PENDING');
        await db.prepare(`UPDATE notifications SET status = ?, sent_at = CASE WHEN ? = 'SENT' THEN datetime('now') ELSE sent_at END WHERE notification_id = ?`)
          .run(nStatus, nStatus, nid);
        await logEmail(nid, recipient, subject, out.status, out.detail);
        status = nStatus;
      }
    }
    if (channel === 'SMS') {
      try {
        await smsProviders.sendSms(recipient, message);
        await db.prepare(`UPDATE notifications SET status = 'SENT', sent_at = datetime('now') WHERE notification_id = ?`).run(nid);
        await db.prepare(`INSERT INTO sms_logs (notification_id, mobile, status, response, sent_at)
          VALUES (?,?,?, ?,datetime('now'))`).run(nid, recipient, 'SENT', 'gateway accepted');
        status = 'SENT';
      } catch (e) {
        const stub = /not configured/.test(e.message);
        await db.prepare(`INSERT INTO sms_logs (notification_id, mobile, status, response, sent_at)
          VALUES (?,?,?, ?,datetime('now'))`).run(nid, recipient, stub ? 'PENDING_STUB' : 'FAILED', stub ? 'SMS disabled in v1; set SMS_WEBHOOK_URL' : e.message);
        status = stub ? 'PENDING' : 'FAILED';
      }
    }
    if (channel === 'WHATSAPP') await db.prepare(`INSERT INTO whatsapp_logs (notification_id, mobile, status, response, sent_at)
      VALUES (?,?,?,?,datetime('now'))`).run(nid, recipient, 'PENDING_STUB', 'WhatsApp disabled in v1');
    results.push({ notificationId: nid, channel, status });
  }
  return results;
}

module.exports = { dispatch, smsProviders, whatsappProviders };
