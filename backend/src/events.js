// Central internal event bus. All modules publish here.
// v1 channels: IN_APP + EMAIL (console/log tables). SMS/WhatsApp have log
// tables and a clean interface (sendSms/sendWhatsapp stubs) for later.
const db = require('./db');

const smsProviders = {
  sendSms: async (mobile, message) => ({ status: 'QUEUED_STUB', mobile }),
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

function logEmail(notificationId, address, subject, status, response) {
  db.prepare(`INSERT INTO email_logs (notification_id, email_address, subject, status, response, sent_at)
    VALUES (?,?,?,?,?,datetime('now'))`).run(notificationId, address, subject, status, response);
}

async function dispatch({ eventCode, tenantId = null, userId = null, vars = {} }) {
  const templates = db.prepare(
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
      // v1: log + console (no external SMTP required). Plug real mailer here later.
      console.log(`[EMAIL] to=${recipient} subject=${subject} msg=${message}`);
    } else if (channel === 'IN_APP') {
      status = 'DELIVERED';
    } else {
      // SMS/WHATSAPP intentionally stubbed in v1.
      status = 'PENDING';
      sentAt = null;
    }
    const info = db.prepare(`INSERT INTO notifications
      (tenant_id, user_id, template_id, event_code, channel, recipient, subject, message, status, sent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, userId, t.template_id || null, eventCode, channel, recipient, subject, message, status, sentAt);
    const nid = info.lastInsertRowid;
    if (channel === 'EMAIL') logEmail(nid, recipient, subject, 'SENT', 'console-log v1');
    if (channel === 'SMS') db.prepare(`INSERT INTO sms_logs (notification_id, mobile, status, response, sent_at)
      VALUES (?,?,?,?,datetime('now'))`).run(nid, recipient, 'PENDING_STUB', 'SMS disabled in v1');
    if (channel === 'WHATSAPP') db.prepare(`INSERT INTO whatsapp_logs (notification_id, mobile, status, response, sent_at)
      VALUES (?,?,?,?,datetime('now'))`).run(nid, recipient, 'PENDING_STUB', 'WhatsApp disabled in v1');
    results.push({ notificationId: nid, channel, status });
  }
  return results;
}

module.exports = { dispatch, smsProviders, whatsappProviders };
