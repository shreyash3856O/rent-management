const API = '';
async function req(path, opts = {}) {
  const token = localStorage.getItem('prm_token');
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
  return data;
}
export const api = {
  get: (p) => req(p),
  post: (p, b) => req(p, { method: 'POST', body: JSON.stringify(b || {}) }),
  put: (p, b) => req(p, { method: 'PUT', body: JSON.stringify(b || {}) }),
  del: (p, confirm) => req(p + (confirm ? '?confirm=true' : ''), { method: 'DELETE' }),
};
export function money(n) {
  const v = Number(n || 0);
  return 'Rs.' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
export function fmtDate(s) { return s ? String(s).slice(0, 10) : ''; }
