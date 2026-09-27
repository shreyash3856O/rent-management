import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, NavLink, useNavigate, Navigate } from 'react-router-dom';
import { api, money, fmtDate } from './api.js';

function useFetch(path, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => {
    setErr(null);
    api.get(path).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(load, deps);
  return [data, err, load, setData];
}
function Field({ label, error, children }) {
  return (<div><label>{label}</label>{children}{error ? <div className="field-err">{error}</div> : null}</div>);
}
function need(v) { return v == null || String(v).trim() === '' ? 'Required.' : null; }

/* ---------- login ---------- */
function AdminLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState('admin@abcproperty.com');
  const [password, setPassword] = useState('admin123');
  const [err, setErr] = useState(null);
  return (<div className="login-wrap">
    <h1>Rent Ledger. Admin sign in.</h1>
    <p className="sub">Use email and password. Demo account is prefilled.</p>
    <Field label="Email" error={need(email)}><input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
    <Field label="Password" error={need(password)}><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" disabled={!email || !password} onClick={async () => {
      try { const r = await api.post('/api/auth/login', { email, password }); localStorage.setItem('prm_token', r.token); localStorage.setItem('prm_role', 'staff'); nav('/admin'); }
      catch (e) { setErr(e.message); }
    }}>Sign in</button> <Link to="/tenant/login">Tenant sign in</Link></p>
  </div>);
}
function TenantLogin() {
  const nav = useNavigate();
  const [mobile, setMobile] = useState('9000000001');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(null);
  const [err, setErr] = useState(null);
  return (<div className="login-wrap">
    <h1>Rent Ledger. Tenant sign in.</h1>
    <p className="sub">Step 1, request OTP. Step 2, enter OTP. Demo OTP is shown on screen.</p>
    <Field label="Mobile" error={need(mobile)}><input value={mobile} onChange={(e) => setMobile(e.target.value)} /></Field>
    <p><button onClick={async () => { try { const r = await api.post('/api/auth/tenant/request-otp', { mobile }); setSent(r.otp); setErr(null); } catch (e) { setErr(e.message); } }}>Request OTP</button></p>
    {sent ? <div className="notice">Demo OTP for {mobile}: <b>{sent}</b>. Enter it below.</div> : null}
    <Field label="OTP"><input value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" disabled={!mobile || !otp} onClick={async () => {
      try { const r = await api.post('/api/auth/tenant/verify-otp', { mobile, otp }); localStorage.setItem('prm_token', r.token); localStorage.setItem('prm_role', 'tenant'); nav('/tenant'); }
      catch (e) { setErr(e.message); }
    }}>Verify and sign in</button> <Link to="/login">Admin sign in</Link></p>
  </div>);
}
function logout(nav) { localStorage.removeItem('prm_token'); localStorage.removeItem('prm_role'); nav('/login'); }

/* ---------- admin ---------- */
function AdminLayout() {
  const nav = useNavigate();
  const items = [['/admin', 'Dashboard'], ['/admin/hierarchy', 'Properties'], ['/admin/tenants', 'Tenants'], ['/admin/agreements', 'Agreements'], ['/admin/invoices', 'Invoices'], ['/admin/payments', 'Payments'], ['/admin/complaints', 'Complaints'], ['/admin/audit', 'Audit log']];
  return (<div><div className="topbar"><span className="brand">Rent Ledger. Admin.</span>
    <span><Link to="/tenant">Tenant view</Link> <button onClick={() => { if (window.confirm('Sign out now?')) logout(nav); }}>Sign out</button></span></div>
    <div className="layout"><nav className="sidenav">{items.map(([p, l]) => <NavLink key={p} to={p} end={p === '/admin'} className={({ isActive }) => isActive ? 'active' : ''}>{l}</NavLink>)}</nav>
      <div className="content"><Routes>
        <Route index element={<Dashboard />} />
        <Route path="hierarchy" element={<Hierarchy />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="agreements" element={<Agreements />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="payments" element={<Payments />} />
        <Route path="complaints" element={<AdminComplaints />} />
        <Route path="audit" element={<Audit />} />
      </Routes></div></div></div>);
}
function Dashboard() {
  const [d, err, load] = useFetch('/api/dashboard/summary');
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  if (err) return <div className="field-err">{err}</div>;
  if (!d) return <p>Loading summary.</p>;
  return (<div><h1>Portfolio summary.</h1><p className="sub">Live counts and current month rent position. Per property drill down below.</p>
    <div className="kpis">
      <div className="kpi"><div className="n">{d.units.total || 0}</div><div className="l">Total units</div></div>
      <div className="kpi"><div className="n">{(d.units.OCCUPIED || 0) + (d.units.PARTIALLY_OCCUPIED || 0)}</div><div className="l">Occupied</div></div>
      <div className="kpi"><div className="n">{d.units.AVAILABLE || 0}</div><div className="l">Vacant</div></div>
      <div className="kpi"><div className="n">{d.units.MAINTENANCE || 0}</div><div className="l">Maintenance</div></div>
    </div>
    <div className="kpis">
      <div className="kpi"><div className="n">{money(d.finance.expected)}</div><div className="l">Expected this month</div></div>
      <div className="kpi"><div className="n">{money(d.finance.collected)}</div><div className="l">Collected</div></div>
      <div className="kpi"><div className="n">{money(d.finance.outstanding)}</div><div className="l">Outstanding</div></div>
      <div className="kpi"><div className="n overdue-text">{money(d.finance.overdue)}</div><div className="l">Overdue ({d.finance.n || 0})</div></div>
    </div>
    <h2>Per property.</h2>
    <table className="grid"><thead><tr><th>Property</th><th>Units</th><th>Occupied</th><th>Invoiced</th><th>Collected</th><th>Outstanding</th></tr></thead>
      <tbody>{(d.perProperty || []).map((p) => <tr key={p.property_id}><td>{p.property_name}</td><td>{p.units}</td><td>{p.occupied}</td><td>{money(p.invoiced)}</td><td>{money(p.collected)}</td><td>{money(p.outstanding)}</td></tr>)}</tbody></table>
  </div>);
}
function Hierarchy() {
  const [props, , lp] = useFetch('/api/properties');
  const [blds, , lb] = useFetch('/api/buildings');
  const [flrs, , lf] = useFetch('/api/floors');
  const [units, , lu] = useFetch('/api/units');
  const [beds, , lbd] = useFetch('/api/beds');
  const reload = () => { lp(); lb(); lf(); lu(); lbd(); };
  const [f, setF] = useState({ kind: 'property', property_code: '', property_name: '', property_type: 'PG', city: '', building_code: '', building_name: '', property_id: '', building_id: '', floor_number: '', floor_name: '', floor_id: '', unit_number: '', monthly_rent: '', unit_id: '', bed_number: '' });
  const [err, setErr] = useState(null);
  const add = async () => {
    setErr(null);
    try {
      if (f.kind === 'property') {
        if (need(f.property_code) || need(f.property_name)) { setErr('Property code and name are required.'); return; }
        await api.post('/api/properties', { organization_id: 1, property_code: f.property_code, property_name: f.property_name, property_type: f.property_type, city: f.city });
      } else if (f.kind === 'building') {
        if (need(f.property_id) || need(f.building_code) || need(f.building_name)) { setErr('Property, code and name are required.'); return; }
        await api.post('/api/buildings', { property_id: Number(f.property_id), building_code: f.building_code, building_name: f.building_name });
      } else if (f.kind === 'floor') {
        if (need(f.building_id) || need(f.floor_number)) { setErr('Building and floor number are required.'); return; }
        await api.post('/api/floors', { building_id: Number(f.building_id), floor_number: Number(f.floor_number), floor_name: f.floor_name });
      } else if (f.kind === 'unit') {
        if (need(f.floor_id) || need(f.unit_number) || need(f.monthly_rent)) { setErr('Floor, unit number and rent are required.'); return; }
        await api.post('/api/units', { floor_id: Number(f.floor_id), unit_number: f.unit_number, monthly_rent: Number(f.monthly_rent), security_deposit: 0 });
      } else {
        if (need(f.unit_id) || need(f.bed_number)) { setErr('Unit and bed number are required.'); return; }
        await api.post('/api/beds', { unit_id: Number(f.unit_id), bed_number: f.bed_number, monthly_rent: 0 });
      }
      setF({ ...f, property_code: '', property_name: '', building_code: '', building_name: '', floor_number: '', floor_name: '', unit_number: '', monthly_rent: '', bed_number: '' });
      reload();
    } catch (e) { setErr(e.message); }
  };
  const set = (k, v) => setF({ ...f, [k]: v });
  return (<div><h1>Properties, buildings, floors, rooms, beds.</h1>
    <p className="sub">Add one level at a time. Bed level rows support PG and hostel sharing.</p>
    <div className="toolbar"><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
      <option value="property">Property</option><option value="building">Building</option><option value="floor">Floor</option><option value="unit">Room or unit</option><option value="bed">Bed</option></select></div>
    {f.kind === 'property' ? <div className="form-grid">
      <Field label="Code" error={need(f.property_code)}><input value={f.property_code} onChange={(e) => set('property_code', e.target.value)} /></Field>
      <Field label="Name" error={need(f.property_name)}><input value={f.property_name} onChange={(e) => set('property_name', e.target.value)} /></Field>
      <Field label="Type"><select value={f.property_type} onChange={(e) => set('property_type', e.target.value)}><option>PG</option><option>HOSTEL</option><option>APARTMENT</option><option>RESIDENTIAL</option><option>COMMERCIAL</option></select></Field>
      <Field label="City"><input value={f.city} onChange={(e) => set('city', e.target.value)} /></Field></div> : null}
    {f.kind === 'building' ? <div className="form-grid">
      <Field label="Property"><select value={f.property_id} onChange={(e) => set('property_id', e.target.value)}><option value="">Select</option>{(props || []).map((p) => <option key={p.property_id} value={p.property_id}>{p.property_name}</option>)}</select></Field>
      <Field label="Code" error={need(f.building_code)}><input value={f.building_code} onChange={(e) => set('building_code', e.target.value)} /></Field>
      <Field label="Name" error={need(f.building_name)}><input value={f.building_name} onChange={(e) => set('building_name', e.target.value)} /></Field></div> : null}
    {f.kind === 'floor' ? <div className="form-grid">
      <Field label="Building"><select value={f.building_id} onChange={(e) => set('building_id', e.target.value)}><option value="">Select</option>{(blds || []).map((b) => <option key={b.building_id} value={b.building_id}>{b.building_name}</option>)}</select></Field>
      <Field label="Floor number" error={need(f.floor_number)}><input value={f.floor_number} onChange={(e) => set('floor_number', e.target.value)} /></Field>
      <Field label="Floor name"><input value={f.floor_name} onChange={(e) => set('floor_name', e.target.value)} /></Field></div> : null}
    {f.kind === 'unit' ? <div className="form-grid">
      <Field label="Floor"><select value={f.floor_id} onChange={(e) => set('floor_id', e.target.value)}><option value="">Select</option>{(flrs || []).map((x) => <option key={x.floor_id} value={x.floor_id}>{x.floor_name || x.floor_number}</option>)}</select></Field>
      <Field label="Room number" error={need(f.unit_number)}><input value={f.unit_number} onChange={(e) => set('unit_number', e.target.value)} /></Field>
      <Field label="Monthly rent" error={need(f.monthly_rent)}><input value={f.monthly_rent} onChange={(e) => set('monthly_rent', e.target.value)} /></Field></div> : null}
    {f.kind === 'bed' ? <div className="form-grid">
      <Field label="Room"><select value={f.unit_id} onChange={(e) => set('unit_id', e.target.value)}><option value="">Select</option>{(units || []).map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_number} ({u.status})</option>)}</select></Field>
      <Field label="Bed number" error={need(f.bed_number)}><input value={f.bed_number} onChange={(e) => set('bed_number', e.target.value)} /></Field></div> : null}
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" onClick={add}>Add {f.kind}</button></p>
    <h2>Rooms and beds.</h2>
    <table className="grid"><thead><tr><th>Room</th><th>Status</th><th>Rent</th><th>Beds</th></tr></thead><tbody>
      {(units || []).map((u) => <tr key={u.unit_id}><td>{u.unit_number}</td><td><span className="tag">{u.status}</span></td><td>{money(u.monthly_rent)}</td>
        <td>{(beds || []).filter((b) => b.unit_id === u.unit_id).map((b) => `${b.bed_number}:${b.status}`).join(', ')}</td></tr>)}</tbody></table>
  </div>);
}
function Tenants() {
  const [list, , load] = useFetch('/api/tenants');
  const [kyc] = useFetch('/api/kyc');
  const [f, setF] = useState({ full_name: '', mobile: '', email: '' });
  const [err, setErr] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  return (<div><h1>Tenants and KYC.</h1><p className="sub">Register a tenant, then set KYC status. Verification detail stays on this page.</p>
    <div className="form-grid">
      <Field label="Full name" error={need(f.full_name)}><input value={f.full_name} onChange={(e) => set('full_name', e.target.value)} /></Field>
      <Field label="Mobile" error={need(f.mobile)}><input value={f.mobile} onChange={(e) => set('mobile', e.target.value)} /></Field>
      <Field label="Email"><input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field></div>
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" onClick={async () => {
      try { if (need(f.full_name) || need(f.mobile)) { setErr('Name and mobile are required.'); return; } await api.post('/api/tenants', f); setF({ full_name: '', mobile: '', email: '' }); setErr(null); load(); } catch (e) { setErr(e.message); }
    }}>Register tenant</button></p>
    <table className="grid"><thead><tr><th>Name</th><th>Mobile</th><th>KYC</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((t) => {
        const k = (kyc || []).find((x) => x.tenant_id === t.tenant_id);
        return <tr key={t.tenant_id}><td>{t.full_name}</td><td>{t.mobile}</td><td><span className="tag">{k ? k.status : 'KYC_PENDING'}</span>{k && k.verified_by ? ` by ${k.verified_by} on ${fmtDate(k.verification_date)}` : ''}</td>
          <td className="row-actions"><button onClick={async () => { await api.put(`/api/kyc/${t.tenant_id}`, { status: 'VERIFIED', remarks: 'Verified at counter' }); window.location.reload(); }}>Mark verified</button>
            <button onClick={async () => { if (window.confirm(`Delete tenant ${t.full_name}? This cannot be undone.`)) { await api.del(`/api/tenants/${t.tenant_id}`, true); load(); } }}>Delete</button></td></tr>;
      })}</tbody></table>
  </div>);
}
function Agreements() {
  const [list, , load] = useFetch('/api/agreements');
  const [tenants] = useFetch('/api/tenants');
  const [props] = useFetch('/api/properties');
  const [f, setF] = useState({ tenant_id: '', property_id: '', agreement_number: '', start_date: '', monthly_rent: '', status: 'ACTIVE' });
  const [err, setErr] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  return (<div><h1>Rental agreements.</h1><p className="sub">Activating marks the linked bed or room Occupied. Terminating releases it.</p>
    <div className="form-grid">
      <Field label="Tenant"><select value={f.tenant_id} onChange={(e) => set('tenant_id', e.target.value)}><option value="">Select</option>{(tenants || []).map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.full_name}</option>)}</select></Field>
      <Field label="Property"><select value={f.property_id} onChange={(e) => set('property_id', e.target.value)}><option value="">Select</option>{(props || []).map((p) => <option key={p.property_id} value={p.property_id}>{p.property_name}</option>)}</select></Field>
      <Field label="Agreement no" error={need(f.agreement_number)}><input value={f.agreement_number} onChange={(e) => set('agreement_number', e.target.value)} /></Field>
      <Field label="Start date" error={need(f.start_date)}><input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
      <Field label="Monthly rent" error={need(f.monthly_rent)}><input value={f.monthly_rent} onChange={(e) => set('monthly_rent', e.target.value)} /></Field>
      <Field label="Status"><select value={f.status} onChange={(e) => set('status', e.target.value)}><option>DRAFT</option><option>PENDING_SIGNATURE</option><option>ACTIVE</option></select></Field></div>
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" onClick={async () => {
      try { await api.post('/api/agreements', { ...f, tenant_id: Number(f.tenant_id), property_id: Number(f.property_id), monthly_rent: Number(f.monthly_rent) }); setErr(null); load(); } catch (e) { setErr(e.message); }
    }}>Create agreement</button></p>
    <table className="grid"><thead><tr><th>No</th><th>Tenant</th><th>Rent</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((a) => <tr key={a.agreement_id}><td>{a.agreement_number}</td><td>{a.tenant_name}</td><td>{money(a.monthly_rent)}</td><td><span className="tag">{a.status}</span></td>
        <td className="row-actions">{a.status === 'ACTIVE' ? <button onClick={async () => { if (window.confirm(`Terminate agreement ${a.agreement_number}? The room or bed returns to Available.`)) { await api.put(`/api/agreements/${a.agreement_id}`, { status: 'TERMINATED', confirm: true }); load(); } }}>Terminate</button> : <button onClick={async () => { await api.put(`/api/agreements/${a.agreement_id}`, { status: 'ACTIVE' }); load(); }}>Activate</button>}</td></tr>)}</tbody></table>
  </div>);
}
function Invoices() {
  const [list, , load] = useFetch('/api/invoices');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7) + '-01');
  const [msg, setMsg] = useState(null);
  const [pay, setPay] = useState({ invoice_id: '', amount: '', payment_mode: 'UPI', payment_reference: '' });
  const gen = async () => {
    try { const r = await api.post('/api/jobs/generate-rent', { month }); setMsg(`Generated ${r.created} invoices, skipped ${r.skipped} duplicates for ${r.month}.`); load(); }
    catch (e) { setMsg(e.message); }
  };
  const record = async () => {
    try {
      if (!pay.invoice_id || !(Number(pay.amount) > 0)) { setMsg('Select an invoice and enter an amount greater than 0.'); return; }
      if (!window.confirm(`Record ${money(pay.amount)} against this invoice? Receipt is generated automatically.`)) return;
      await api.post('/api/payments', { invoice_id: Number(pay.invoice_id), amount: Number(pay.amount), payment_mode: pay.payment_mode, payment_reference: pay.payment_reference, confirm: true });
      setMsg('Payment recorded. Invoice totals and receipt updated.'); setPay({ invoice_id: '', amount: '', payment_mode: 'UPI', payment_reference: '' }); load();
    } catch (e) { setMsg(e.message); }
  };
  return (<div><h1>Rent invoices.</h1><p className="sub">One invoice per active agreement per month. Format is INV-YYYYMM-000000.</p>
    <div className="toolbar"><input type="date" value={month} onChange={(e) => setMonth(e.target.value)} /><button className="primary" onClick={gen}>Generate month</button>
      <button onClick={async () => { await api.post('/api/jobs/mark-overdue', {}); load(); }}>Mark overdue</button></div>
    {msg ? <div className="notice">{msg}</div> : null}
    <h2>Record payment.</h2>
    <div className="form-grid">
      <Field label="Invoice"><select value={pay.invoice_id} onChange={(e) => setPay({ ...pay, invoice_id: e.target.value })}><option value="">Select</option>{(list || []).filter((i) => i.outstanding_amount > 0).map((i) => <option key={i.invoice_id} value={i.invoice_id}>{i.invoice_number} ({money(i.outstanding_amount)} due)</option>)}</select></Field>
      <Field label="Amount"><input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
      <Field label="Mode"><select value={pay.payment_mode} onChange={(e) => setPay({ ...pay, payment_mode: e.target.value })}><option>UPI</option><option>CASH</option><option>CHEQUE</option><option>NET_BANKING</option><option>CREDIT_CARD</option><option>DEBIT_CARD</option><option>BANK_TRANSFER</option></select></Field>
      <Field label="Reference"><input value={pay.payment_reference} onChange={(e) => setPay({ ...pay, payment_reference: e.target.value })} /></Field></div>
    <p><button className="primary" onClick={record}>Record payment</button></p>
    <table className="grid"><thead><tr><th>Number</th><th>Tenant</th><th>Month</th><th>Due</th><th>Total</th><th>Paid</th><th>Due bal</th><th>Status</th></tr></thead><tbody>
      {(list || []).map((i) => <tr key={i.invoice_id}><td>{i.invoice_number}</td><td>{i.tenant_name}</td><td>{fmtDate(i.invoice_month)}</td><td>{fmtDate(i.due_date)}</td><td>{money(i.total_amount)}</td><td>{money(i.paid_amount)}</td><td>{money(i.outstanding_amount)}</td><td>{i.status === 'OVERDUE' ? <span className="tag overdue">OVERDUE</span> : <span className="tag">{i.status}</span>}</td></tr>)}</tbody></table>
  </div>);
}
function Payments() {
  const [list] = useFetch('/api/payments');
  const [rc] = useFetch('/api/receipts');
  const dl = (r) => {
    const txt = `RENT RECEIPT\nReceipt: ${r.receipt_number}\nDate: ${fmtDate(r.receipt_date)}\nTenant: ${r.tenant_name || ''}\nAmount: ${r.amount}\nPayment ID: ${r.payment_id}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = `${r.receipt_number}.txt`; a.click();
  };
  return (<div><h1>Payments and receipts.</h1><p className="sub">Every SUCCESS payment creates a receipt. Invoices reach PAID only through payment rows.</p>
    <h2>Receipts.</h2>
    <table className="grid"><thead><tr><th>Receipt</th><th>Tenant</th><th>Amount</th><th>Date</th><th>Action</th></tr></thead><tbody>
      {(rc || []).map((r) => <tr key={r.receipt_id}><td>{r.receipt_number}</td><td>{r.tenant_name}</td><td>{money(r.amount)}</td><td>{fmtDate(r.receipt_date)}</td><td><button onClick={() => dl(r)}>Download</button></td></tr>)}</tbody></table>
    <h2>Payments.</h2>
    <table className="grid"><thead><tr><th>ID</th><th>Tenant</th><th>Amount</th><th>Mode</th><th>Status</th><th>Ref</th></tr></thead><tbody>
      {(list || []).map((p) => <tr key={p.payment_id}><td>{p.payment_id}</td><td>{p.tenant_name}</td><td>{money(p.amount)}</td><td>{p.payment_mode}</td><td><span className="tag">{p.status}</span></td><td>{p.payment_reference}</td></tr>)}</tbody></table>
  </div>);
}
function AdminComplaints() {
  const [list, , load] = useFetch('/api/complaints');
  const adv = async (c) => {
    const flow = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
    const nxt = flow[flow.indexOf(c.status) + 1];
    if (!nxt) return;
    await api.put(`/api/complaints/${c.complaint_id}`, { status: nxt });
    load();
  };
  return (<div><h1>Complaints.</h1><p className="sub">Flow is Open, Assigned, In Progress, Resolved, Closed. Steps only move forward.</p>
    <table className="grid"><thead><tr><th>No</th><th>Tenant</th><th>Category</th><th>Title</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((c) => <tr key={c.complaint_id}><td>{c.complaint_number}</td><td>{c.tenant_name}</td><td>{c.category}</td><td>{c.title}</td><td><span className="tag">{c.status}</span></td><td><button onClick={() => adv(c)}>Advance</button></td></tr>)}</tbody></table>
  </div>);
}
function Audit() {
  const [list] = useFetch('/api/audit-logs');
  return (<div><h1>Audit log.</h1><p className="sub">Every financial or tenant data change is recorded with user, action and timestamp.</p>
    <table className="grid"><thead><tr><th>When</th><th>User</th><th>Module</th><th>Action</th><th>Entity</th></tr></thead><tbody>
      {(list || []).map((a) => <tr key={a.audit_id}><td>{a.created_at}</td><td>{a.user_id}</td><td>{a.module_name}</td><td>{a.action}</td><td>{a.entity_type} {a.entity_id}</td></tr>)}</tbody></table>
  </div>);
}

/* ---------- tenant ---------- */
function TenantLayout() {
  const nav = useNavigate();
  return (<div><div className="topbar"><span className="brand">Rent Ledger. Tenant.</span>
    <span><Link to="/admin">Admin view</Link> <button onClick={() => { if (window.confirm('Sign out now?')) logout(nav); }}>Sign out</button></span></div>
    <div className="tenant-wrap"><nav className="toolbar">
      <NavLink to="/tenant" end>Home</NavLink><NavLink to="/tenant/rent">Rent</NavLink><NavLink to="/tenant/complaints">Complaints</NavLink><NavLink to="/tenant/docs">Documents</NavLink><NavLink to="/tenant/notices">Notices</NavLink>
    </nav><Routes>
      <Route index element={<THome />} /><Route path="rent" element={<TRent />} /><Route path="complaints" element={<TComplaints />} /><Route path="docs" element={<TDocs />} /><Route path="notices" element={<TNotices />} />
    </Routes></div></div>);
}
function THome() {
  const [d, err] = useFetch('/api/tenant/me');
  if (err) return <div className="field-err">{err}</div>;
  if (!d) return <p>Loading.</p>;
  const od = Number(d.dues?.overdue || 0) > 0;
  return (<div><h1>Hello, {d.tenant?.full_name}.</h1>
    <p className="sub">Room {d.agreement?.unit_number || 'not assigned'}{d.agreement?.bed_number ? `, bed ${d.agreement.bed_number}` : ''}. Rent {money(d.agreement?.monthly_rent)}. Outstanding {money(d.dues?.outstanding)}.</p>
    {od ? <div className="notice overdue-text">Rent overdue. {money(d.dues.overdue)} is past due. Pay now to clear it.</div> : null}
    <div className="kpis"><div className="kpi"><div className="n">{money(d.dues?.outstanding)}</div><div className="l">Outstanding</div></div>
      <div className="kpi"><div className="n">{d.agreement ? fmtDate(d.agreement.end_date) : '-'}</div><div className="l">Agreement ends</div></div></div>
    <div className="paybar"><span>Due: {money(d.dues?.outstanding)}</span><Link className="btn primary" to="/tenant/rent">Pay rent</Link></div>
  </div>);
}
function TRent() {
  const [inv] = useFetch('/api/tenant/invoices');
  const [pay] = useFetch('/api/tenant/payments');
  const dl = (r) => {
    const txt = `RENT RECEIPT\nReceipt: ${r.receipt_number}\nDate: ${fmtDate(r.receipt_date || r.payment_date)}\nAmount: ${r.amount}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = `${r.receipt_number || 'receipt-' + r.payment_id}.txt`; a.click();
  };
  return (<div><h1>Rent and receipts.</h1><p className="sub">Current invoice first, then history. Payment is recorded by the office in v1.</p>
    <h2>Current and past invoices.</h2>
    <table className="grid"><thead><tr><th>Number</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th></tr></thead><tbody>
      {(inv || []).map((i) => <tr key={i.invoice_id}><td>{i.invoice_number}</td><td>{fmtDate(i.due_date)}</td><td>{money(i.total_amount)}</td><td>{money(i.paid_amount)}</td><td>{i.status === 'OVERDUE' ? <span className="tag overdue">OVERDUE by record</span> : <span className="tag">{i.status}</span>}</td></tr>)}</tbody></table>
    <h2>Payment history.</h2>
    <table className="grid"><thead><tr><th>Receipt</th><th>Amount</th><th>Date</th><th>Action</th></tr></thead><tbody>
      {(pay || []).map((p) => <tr key={p.payment_id}><td>{p.receipt_number || '-'}</td><td>{money(p.amount)}</td><td>{fmtDate(p.payment_date)}</td><td>{p.receipt_number ? <button onClick={() => dl(p)}>Download</button> : null}</td></tr>)}</tbody></table>
  </div>);
}
function TComplaints() {
  const [me] = useFetch('/api/tenant/me');
  const [list, , load] = useFetch('/api/tenant/me');
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ category: 'PLUMBING', title: '', description: '' });
  const [msg, setMsg] = useState(null);
  const loadList = async () => { try { const r = await api.get('/api/complaints'); setRows(r.filter((x) => x.tenant_id === me?.tenant?.tenant_id)); } catch {} };
  useEffect(() => { if (me) loadList(); }, [me]);
  return (<div><h1>Complaints.</h1><p className="sub">File a complaint and track it to closure.</p>
    <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option>ELECTRICITY</option><option>WATER</option><option>PLUMBING</option><option>AC</option><option>FURNITURE</option><option>INTERNET</option><option>CLEANING</option><option>SECURITY</option><option>OTHER</option></select></Field>
    <Field label="Title" error={need(f.title)}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    <Field label="Description"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    {msg ? <div className="notice">{msg}</div> : null}
    <p><button className="primary" onClick={async () => {
      try { if (need(f.title)) { setMsg('Title is required.'); return; } await api.post('/api/complaints', { property_id: me.agreement?.property_id, category: f.category, title: f.title, description: f.description }); setMsg('Complaint filed.'); setF({ category: 'PLUMBING', title: '', description: '' }); loadList(); } catch (e) { setMsg(e.message); }
    }}>File complaint</button></p>
    <table className="grid"><thead><tr><th>No</th><th>Title</th><th>Status</th></tr></thead><tbody>
      {rows.map((c) => <tr key={c.complaint_id}><td>{c.complaint_number}</td><td>{c.title}</td><td><span className="tag">{c.status}</span></td></tr>)}</tbody></table>
  </div>);
}
function TDocs() {
  const [d] = useFetch('/api/tenant/documents');
  if (!d) return <p>Loading.</p>;
  return (<div><h1>Documents.</h1><p className="sub">Agreement, KYC record and uploaded ID proofs.</p>
    <p>KYC status: <span className="tag">{d.kyc?.status || 'KYC_PENDING'}</span></p>
    <h2>Agreements.</h2><table className="grid"><thead><tr><th>No</th><th>Status</th><th>Period</th></tr></thead><tbody>
      {(d.agreements || []).map((a) => <tr key={a.agreement_id}><td>{a.agreement_number}</td><td>{a.status}</td><td>{fmtDate(a.start_date)} to {fmtDate(a.end_date)}</td></tr>)}</tbody></table>
    <h2>ID documents.</h2><table className="grid"><thead><tr><th>Type</th><th>Status</th><th>File</th></tr></thead><tbody>
      {(d.documents || []).map((x) => <tr key={x.tenant_document_id}><td>{x.document_type}</td><td>{x.verification_status}</td><td>{x.file_path}</td></tr>)}</tbody></table>
  </div>);
}
function TNotices() {
  const [list] = useFetch('/api/notifications');
  if (!list) return <p>Loading.</p>;
  return (<div><h1>Notices.</h1><p className="sub">Invoice, payment and overdue messages.</p>
    <table className="grid"><thead><tr><th>When</th><th>Subject</th><th>Message</th></tr></thead><tbody>
      {list.map((n) => <tr key={n.notification_id}><td>{fmtDate(n.created_at)}</td><td>{n.subject}</td><td>{n.message}</td></tr>)}</tbody></table>
  </div>);
}

/* ---------- shell ---------- */
function Guard({ role, children }) {
  const t = localStorage.getItem('prm_token');
  if (!t) return <Navigate to={role === 'tenant' ? '/tenant/login' : '/login'} />;
  return children;
}
export default function App() {
  return (<BrowserRouter><Routes>
    <Route path="/login" element={<AdminLogin />} />
    <Route path="/tenant/login" element={<TenantLogin />} />
    <Route path="/admin/*" element={<Guard role="staff"><AdminLayout /></Guard>} />
    <Route path="/tenant/*" element={<Guard role="tenant"><TenantLayout /></Guard>} />
    <Route path="/" element={<Navigate to={(localStorage.getItem('prm_role') === 'tenant') ? '/tenant' : '/admin'} />} />
  </Routes></BrowserRouter>);
}
