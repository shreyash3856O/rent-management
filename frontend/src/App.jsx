import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Link, NavLink, useNavigate, useLocation, useParams, Navigate } from 'react-router-dom';
import { api, money, fmtDate, uploadFile, fileUrl, busy, withBusy } from './api.js';

function useFetch(path, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => {
    setErr(null);
    api.get(path).then(setData).catch((e) => setErr(e.message));
  }, [path]);
  useEffect(load, [load, ...deps]);
  return [data, err, load, setData];
}
// Refetch a list whenever the tab regains focus, so dropdowns never show
// yesterday's data after work done in another tab.
function useFocusReload(load) {
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
}
function Field({ label, error, children }) {
  return (<div><label>{label}</label>{children}{error ? <div className="field-err">{error}</div> : null}</div>);
}
function need(v) { return v == null || String(v).trim() === '' ? 'Required.' : null; }
function mobileErr(v) {
  if (need(v)) return 'Required.';
  return /^\d{10}$/.test(String(v)) ? null : 'Enter exactly 10 digits.';
}
function BusyOverlay() {
  const [s, setS] = useState(busy.snapshot());
  useEffect(() => busy.subscribe(setS), []);
  if (!s.active) return null;
  return (<div className="busy-scrim"><div className="busy-box">
    <div className="blob"><span className="eye left" /><span className="eye right" /></div>
    <div className="busy-label">{s.label}</div>
  </div></div>);
}

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
      try { const r = await withBusy('Signing in.', async () => api.post('/api/auth/login', { email, password })); localStorage.setItem('prm_token', r.token); localStorage.setItem('prm_role', 'staff'); nav('/admin'); }
      catch (e) { setErr(e.message); }
    }}>Sign in</button> <Link className="btn" to="/tenant/login">Tenant sign in</Link></p>
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
    <Field label="Mobile" error={mobileErr(mobile)}><input inputMode="numeric" maxLength={10} value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
    <p><button onClick={async () => { try { const r = await withBusy('Requesting OTP.', async () => api.post('/api/auth/tenant/request-otp', { mobile })); setSent(r.otp); setErr(null); } catch (e) { setErr(e.message); } }}>Request OTP</button></p>
    {sent ? <div className="notice">Demo OTP for {mobile}: <b>{sent}</b>. Enter it below.</div> : null}
    <Field label="OTP"><input value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>
    {err ? <div className="field-err">{err}</div> : null}
    <p><button className="primary" disabled={!mobile || !otp} onClick={async () => {
      try { const r = await withBusy('Verifying OTP.', async () => api.post('/api/auth/tenant/verify-otp', { mobile, otp })); localStorage.setItem('prm_token', r.token); localStorage.setItem('prm_role', 'tenant'); nav('/tenant'); }
      catch (e) { setErr(e.message); }
    }}>Verify and sign in</button> <Link className="btn" to="/login">Admin sign in</Link></p>
  </div>);
}
function logout(nav) { localStorage.removeItem('prm_token'); localStorage.removeItem('prm_role'); nav('/login'); }

/* ---------- admin ---------- */
function AdminLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const items = [['/admin', 'Dashboard'], ['/admin/hierarchy', 'Properties'], ['/admin/tenants', 'Tenants'], ['/admin/agreements', 'Agreements'], ['/admin/plans', 'Rent plans'], ['/admin/invoices', 'Invoices'], ['/admin/payments', 'Payments'], ['/admin/complaints', 'Complaints'], ['/admin/audit', 'Audit log']];
  return (<div><div className="topbar"><span className="brand">Rent Ledger. Admin.</span>
    <span className="actions"><span className="sub">Signed in</span> <button onClick={() => { if (window.confirm('Sign out now?')) logout(nav); }}>Sign out</button></span></div>
    <div className="layout"><nav className="sidenav">{items.map(([p, l]) => <NavLink key={p} to={p} end={p === '/admin'} className={({ isActive }) => isActive ? 'active' : ''}>{l}</NavLink>)}</nav>
      <div className="content"><div key={loc.pathname} className="page"><Routes>
        <Route index element={<Dashboard />} />
        <Route path="hierarchy" element={<Hierarchy />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="agreements" element={<Agreements />} />
        <Route path="plans" element={<RentPlans />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="payments" element={<Payments />} />
        <Route path="complaints" element={<AdminComplaints />} />
        <Route path="audit" element={<Audit />} />
        <Route path="receipt/:id" element={<ReceiptView base="/api" />} />
      </Routes></div></div></div></div>);
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
  const [kyc, , loadKyc] = useFetch('/api/kyc');
  useFocusReload(load);
  const [f, setF] = useState({ full_name: '', mobile: '', email: '' });
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [editing, setEditing] = useState(null);
  const [doc, setDoc] = useState({ tenant_id: '', document_type: 'AADHAAR', document_number: '' });
  const [docFile, setDocFile] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  const setE = (k, v) => setEditing({ ...editing, [k]: v });
  const startEdit = (t) => { setEditing({ ...t }); setNote(null); setErr(null); };
  const saveEdit = async () => {
    try {
      if (need(editing.full_name) || mobileErr(editing.mobile)) { setErr('Name and a 10 digit mobile are required.'); return; }
      await withBusy('Saving tenant.', async () => {
        await api.put(`/api/tenants/${editing.tenant_id}`, {
          full_name: editing.full_name, mobile: editing.mobile, email: editing.email || null,
          gender: editing.gender || null, occupation: editing.occupation || null, company_name: editing.company_name || null,
          address: editing.address || null, emergency_contact_name: editing.emergency_contact_name || null,
          emergency_contact_mobile: editing.emergency_contact_mobile || null, id_type: editing.id_type || null,
          id_number: editing.id_number || null, status: editing.status || 'ACTIVE',
        });
      });
      setEditing(null); setErr(null); setNote('Tenant saved.'); load();
    } catch (e) { setErr(e.message); }
  };
  const removeTenant = async (t) => {
    if (!window.confirm(`Delete tenant ${t.full_name}? Their invoices, payments, complaints and documents go with them. Active agreements and unpaid dues block deletion.`)) return;
    try {
      await withBusy('Deleting tenant.', async () => { await api.del(`/api/tenants/${t.tenant_id}`, true); });
      setErr(null); setNote(`Tenant ${t.full_name} deleted.`); load(); loadKyc();
    } catch (e) { setErr(e.message); }
  };
  const markVerified = async (t) => {
    try {
      await withBusy('Updating KYC.', async () => { await api.put(`/api/kyc/${t.tenant_id}`, { status: 'VERIFIED', remarks: 'Verified at counter' }); });
      setErr(null); setNote(`KYC verified for ${t.full_name}.`); loadKyc();
    } catch (e) { setErr(e.message); }
  };
  return (<div><h1>Tenants and KYC.</h1><p className="sub">Register a tenant, then set KYC status. Verification detail stays on this page.</p>
    <div className="form-grid">
      <Field label="Full name" error={need(f.full_name)}><input value={f.full_name} onChange={(e) => set('full_name', e.target.value)} /></Field>
      <Field label="Mobile" error={mobileErr(f.mobile)}><input inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => set('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
      <Field label="Email"><input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field></div>
    {err ? <div className="field-err">{err}</div> : null}
    {note ? <div className="notice">{note}</div> : null}
    <p><button className="primary" onClick={async () => {
      try {
        if (need(f.full_name) || mobileErr(f.mobile)) { setErr('Name and a 10 digit mobile are required.'); return; }
        await withBusy('Registering tenant.', async () => { await api.post('/api/tenants', f); });
        setF({ full_name: '', mobile: '', email: '' }); setErr(null); setNote('Tenant registered.'); load();
      } catch (e) { setErr(e.message); }
    }}>Register tenant</button></p>
    <h2>Add a KYC document.</h2>
    <div className="form-grid">
      <Field label="Tenant"><select value={doc.tenant_id} onChange={(e) => setDoc({ ...doc, tenant_id: e.target.value })}><option value="">Select</option>{(list || []).map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.full_name}</option>)}</select></Field>
      <Field label="Type"><select value={doc.document_type} onChange={(e) => setDoc({ ...doc, document_type: e.target.value })}><option>AADHAAR</option><option>PAN</option><option>PASSPORT</option><option>DRIVING_LICENSE</option><option>ADDRESS_PROOF</option><option>EMPLOYMENT_PROOF</option><option>PHOTO</option><option>OTHER</option></select></Field>
      <Field label="Number"><input value={doc.document_number} onChange={(e) => setDoc({ ...doc, document_number: e.target.value })} /></Field>
      <Field label="File"><input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={(e) => setDocFile(e.target.files[0] || null)} /></Field></div>
    <p><button onClick={async () => {
      try {
        if (!doc.tenant_id || !docFile) { setErr('Pick a tenant and a file first.'); return; }
        await withBusy('Uploading document.', async () => {
          const up = await uploadFile(docFile);
          await api.post('/api/tenant-documents', { tenant_id: Number(doc.tenant_id), document_type: doc.document_type, document_number: doc.document_number || null, file_path: up.file_path });
        });
        setErr(null); setNote('Document uploaded.'); setDoc({ tenant_id: '', document_type: 'AADHAAR', document_number: '' }); setDocFile(null);
      } catch (e) { setErr(e.message); }
    }}>Upload document</button></p>
    {editing ? <div><h2>Editing {editing.full_name}.</h2>
      <div className="form-grid">
        <Field label="Full name" error={need(editing.full_name)}><input value={editing.full_name || ''} onChange={(e) => setE('full_name', e.target.value)} /></Field>
        <Field label="Mobile" error={mobileErr(editing.mobile)}><input inputMode="numeric" maxLength={10} value={editing.mobile || ''} onChange={(e) => setE('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
        <Field label="Email"><input value={editing.email || ''} onChange={(e) => setE('email', e.target.value)} /></Field>
        <Field label="Gender"><select value={editing.gender || ''} onChange={(e) => setE('gender', e.target.value)}><option value="">Select</option><option>MALE</option><option>FEMALE</option><option>OTHER</option></select></Field>
        <Field label="Occupation"><input value={editing.occupation || ''} onChange={(e) => setE('occupation', e.target.value)} /></Field>
        <Field label="Company"><input value={editing.company_name || ''} onChange={(e) => setE('company_name', e.target.value)} /></Field>
        <Field label="Address"><input value={editing.address || ''} onChange={(e) => setE('address', e.target.value)} /></Field>
        <Field label="Emergency contact"><input value={editing.emergency_contact_name || ''} onChange={(e) => setE('emergency_contact_name', e.target.value)} /></Field>
        <Field label="Emergency mobile"><input value={editing.emergency_contact_mobile || ''} onChange={(e) => setE('emergency_contact_mobile', e.target.value)} /></Field>
        <Field label="ID type"><select value={editing.id_type || ''} onChange={(e) => setE('id_type', e.target.value)}><option value="">Select</option><option>AADHAAR</option><option>PAN</option><option>PASSPORT</option><option>DRIVING_LICENSE</option><option>VOTER_ID</option><option>OTHER</option></select></Field>
        <Field label="ID number"><input value={editing.id_number || ''} onChange={(e) => setE('id_number', e.target.value)} /></Field>
        <Field label="Status"><select value={editing.status || 'ACTIVE'} onChange={(e) => setE('status', e.target.value)}><option>ACTIVE</option><option>INACTIVE</option><option>BLACKLISTED</option></select></Field></div>
      <p><button className="primary" onClick={saveEdit}>Save changes</button> <button onClick={() => setEditing(null)}>Cancel</button></p></div> : null}
    <table className="grid"><thead><tr><th>Name</th><th>Mobile</th><th>KYC</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((t) => {
        const k = (kyc || []).find((x) => x.tenant_id === t.tenant_id);
        return <tr key={t.tenant_id}><td>{t.full_name}</td><td>{t.mobile}</td><td><span className="tag">{k ? k.status : 'KYC_PENDING'}</span>{k && k.verified_by ? ` by ${k.verified_by} on ${fmtDate(k.verification_date)}` : ''}</td>
          <td className="row-actions"><button onClick={() => startEdit(t)}>Edit</button>
            <button onClick={() => markVerified(t)}>Mark verified</button>
            <button onClick={() => removeTenant(t)}>Delete</button></td></tr>;
      })}</tbody></table>
  </div>);
}
function RentPlans() {
  const [list, , load] = useFetch('/api/rent-plans');
  const [props] = useFetch('/api/properties');
  const [f, setF] = useState({ property_id: '', plan_name: '', base_rent: '', maintenance_charge: '0', water_charge: '0', other_charges: '0', security_deposit: '', late_fee: '0', due_day: '5' });
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  const setE = (k, v) => setEditing({ ...editing, [k]: v });
  const num = (v, d = 0) => (v === '' || v == null ? d : Number(v));
  const save = async (isEdit) => {
    try {
      const src = isEdit ? editing : f;
      if (!src.property_id || !src.plan_name) { setErr('Property and plan name are required.'); return; }
      const body = {
        property_id: Number(src.property_id), plan_name: src.plan_name, base_rent: num(src.base_rent),
        maintenance_charge: num(src.maintenance_charge), water_charge: num(src.water_charge),
        electricity_mode: src.electricity_mode || 'ACTUAL', electricity_charge: num(src.electricity_charge),
        other_charges: num(src.other_charges), security_deposit: num(src.security_deposit),
        late_fee: num(src.late_fee), due_day: Math.min(Math.max(num(src.due_day, 5), 1), 28),
        status: src.status || 'ACTIVE',
      };
      await withBusy(isEdit ? 'Saving plan.' : 'Creating plan.', async () => {
        if (isEdit) await api.put(`/api/rent-plans/${editing.rent_plan_id}`, body);
        else await api.post('/api/rent-plans', body);
      });
      setEditing(null); setErr(null); setNote(isEdit ? 'Plan saved. Future invoices use the new charges.' : 'Plan created.');
      setF({ property_id: '', plan_name: '', base_rent: '', maintenance_charge: '0', water_charge: '0', other_charges: '0', security_deposit: '', late_fee: '0', due_day: '5' });
      load();
    } catch (e) { setErr(e.message); }
  };
  const remove = async (p) => {
    if (!window.confirm(`Delete plan ${p.plan_name}? Agreements using it block deletion.`)) return;
    try {
      await withBusy('Deleting plan.', async () => { await api.del(`/api/rent-plans/${p.rent_plan_id}`, true); });
      setErr(null); setNote('Plan deleted.'); load();
    } catch (e) { setErr(e.message); }
  };
  return (<div><h1>Rent plans.</h1><p className="sub">A plan sets the maintenance and water charges every invoice copies. Rent itself comes from the agreement. Changes apply to future invoices, never to ones already sent.</p>
    {err ? <div className="field-err">{err}</div> : null}
    {note ? <div className="notice">{note}</div> : null}
    <div className="form-grid">
      <Field label="Property"><select value={f.property_id} onChange={(e) => set('property_id', e.target.value)}><option value="">Select</option>{(props || []).map((p) => <option key={p.property_id} value={p.property_id}>{p.property_name}</option>)}</select></Field>
      <Field label="Plan name" error={need(f.plan_name)}><input value={f.plan_name} onChange={(e) => set('plan_name', e.target.value)} /></Field>
      <Field label="Base rent (reference)"><input value={f.base_rent} onChange={(e) => set('base_rent', e.target.value)} /></Field>
      <Field label="Maintenance"><input value={f.maintenance_charge} onChange={(e) => set('maintenance_charge', e.target.value)} /></Field>
      <Field label="Water"><input value={f.water_charge} onChange={(e) => set('water_charge', e.target.value)} /></Field>
      <Field label="Other charges"><input value={f.other_charges} onChange={(e) => set('other_charges', e.target.value)} /></Field>
      <Field label="Security deposit"><input value={f.security_deposit} onChange={(e) => set('security_deposit', e.target.value)} /></Field>
      <Field label="Late fee"><input value={f.late_fee} onChange={(e) => set('late_fee', e.target.value)} /></Field>
      <Field label="Due day (1 to 28)"><input value={f.due_day} onChange={(e) => set('due_day', e.target.value)} /></Field></div>
    <p><button className="primary" onClick={() => save(false)}>Create plan</button></p>
    {editing ? <div><h2>Editing {editing.plan_name}.</h2>
      <div className="form-grid">
        <Field label="Plan name"><input value={editing.plan_name || ''} onChange={(e) => setE('plan_name', e.target.value)} /></Field>
        <Field label="Base rent (reference)"><input value={editing.base_rent ?? ''} onChange={(e) => setE('base_rent', e.target.value)} /></Field>
        <Field label="Maintenance"><input value={editing.maintenance_charge ?? ''} onChange={(e) => setE('maintenance_charge', e.target.value)} /></Field>
        <Field label="Water"><input value={editing.water_charge ?? ''} onChange={(e) => setE('water_charge', e.target.value)} /></Field>
        <Field label="Other charges"><input value={editing.other_charges ?? ''} onChange={(e) => setE('other_charges', e.target.value)} /></Field>
        <Field label="Security deposit"><input value={editing.security_deposit ?? ''} onChange={(e) => setE('security_deposit', e.target.value)} /></Field>
        <Field label="Late fee"><input value={editing.late_fee ?? ''} onChange={(e) => setE('late_fee', e.target.value)} /></Field>
        <Field label="Due day (1 to 28)"><input value={editing.due_day ?? ''} onChange={(e) => setE('due_day', e.target.value)} /></Field>
        <Field label="Status"><select value={editing.status || 'ACTIVE'} onChange={(e) => setE('status', e.target.value)}><option>ACTIVE</option><option>INACTIVE</option></select></Field></div>
      <p><button className="primary" onClick={() => save(true)}>Save changes</button> <button onClick={() => setEditing(null)}>Cancel</button></p></div> : null}
    <table className="grid"><thead><tr><th>Plan</th><th>Maintenance</th><th>Water</th><th>Other</th><th>Due day</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((p) => <tr key={p.rent_plan_id}><td>{p.plan_name}</td><td>{money(p.maintenance_charge)}</td><td>{money(p.water_charge)}</td><td>{money(p.other_charges)}</td><td>{p.due_day}</td><td><span className="tag">{p.status}</span></td>
        <td className="row-actions"><button onClick={() => { setEditing({ ...p }); setNote(null); setErr(null); }}>Edit</button><button onClick={() => remove(p)}>Delete</button></td></tr>)}</tbody></table>
  </div>);
}
function Agreements() {
  const [list, listErr, load] = useFetch('/api/agreements');
  const [tenants, tenantsErr, loadTenants] = useFetch('/api/tenants');
  const [props, propsErr, loadProps] = useFetch('/api/properties');
  const [plans, plansErr, loadPlans] = useFetch('/api/rent-plans');
  const reloadLists = useCallback(() => { loadTenants(); loadProps(); loadPlans(); load(); }, [loadTenants, loadProps, loadPlans, load]);
  useFocusReload(reloadLists);
  const num = (v, d = 0) => (v === '' || v == null ? d : Number(v));
  const [f, setF] = useState({ tenant_id: '', property_id: '', agreement_number: '', start_date: '', monthly_rent: '', rent_plan_id: '', other_charges: '', due_day: '5', security_deposit: '', status: 'ACTIVE' });
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const set = (k, v) => setF({ ...f, [k]: v });
  const setE = (k, v) => setEditing({ ...editing, [k]: v });
  return (<div><h1>Rental agreements.</h1><p className="sub">Activating marks the linked bed or room Occupied. Terminating releases it. Rent and charges feed every future invoice.</p>
    <div className="toolbar"><button onClick={reloadLists}>Reload lists</button><span className="sub">{(tenants || []).length} tenants, {(props || []).length} properties loaded.</span></div>
    {(listErr || tenantsErr || propsErr || plansErr) ? <div className="field-err">Lists failed to load ({listErr || tenantsErr || propsErr || plansErr}). Press Reload lists.</div> : null}
    <div className="form-grid">
      <Field label="Tenant"><select value={f.tenant_id} onChange={(e) => set('tenant_id', e.target.value)}><option value="">Select</option>{(tenants || []).map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.full_name}</option>)}</select></Field>
      <Field label="Property"><select value={f.property_id} onChange={(e) => set('property_id', e.target.value)}><option value="">Select</option>{(props || []).map((p) => <option key={p.property_id} value={p.property_id}>{p.property_name}</option>)}</select></Field>
      <Field label="Agreement no" error={need(f.agreement_number)}><input value={f.agreement_number} onChange={(e) => set('agreement_number', e.target.value)} /></Field>
      <Field label="Start date" error={need(f.start_date)}><input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
      <Field label="Monthly rent" error={need(f.monthly_rent)}><input value={f.monthly_rent} onChange={(e) => set('monthly_rent', e.target.value)} /></Field>
      <Field label="Rent plan (sets maintenance and water)"><select value={f.rent_plan_id} onChange={(e) => set('rent_plan_id', e.target.value)}><option value="">None</option>{(plans || []).map((p) => <option key={p.rent_plan_id} value={p.rent_plan_id}>{p.plan_name}</option>)}</select></Field>
      <Field label="Other monthly charges"><input value={f.other_charges} onChange={(e) => set('other_charges', e.target.value)} /></Field>
      <Field label="Due day (1 to 28)"><input value={f.due_day} onChange={(e) => set('due_day', e.target.value)} /></Field>
      <Field label="Security deposit"><input value={f.security_deposit} onChange={(e) => set('security_deposit', e.target.value)} /></Field>
      <Field label="Status"><select value={f.status} onChange={(e) => set('status', e.target.value)}><option>DRAFT</option><option>PENDING_SIGNATURE</option><option>ACTIVE</option></select></Field></div>
    {err ? <div className="field-err">{err}</div> : null}
    {note ? <div className="notice">{note}</div> : null}
    <p><button className="primary" onClick={async () => {
      try {
        await withBusy('Creating agreement.', async () => api.post('/api/agreements', {
          ...f, tenant_id: Number(f.tenant_id), property_id: Number(f.property_id), monthly_rent: Number(f.monthly_rent),
          rent_plan_id: f.rent_plan_id ? Number(f.rent_plan_id) : null, other_charges: num(f.other_charges),
          due_day: Math.min(Math.max(num(f.due_day, 5), 1), 28), security_deposit: num(f.security_deposit),
        }));
        setErr(null); setNote('Agreement created.');
        setF({ tenant_id: '', property_id: '', agreement_number: '', start_date: '', monthly_rent: '', rent_plan_id: '', other_charges: '', due_day: '5', security_deposit: '', status: 'ACTIVE' });
        load();
      } catch (e) { setErr(e.message); }
    }}>Create agreement</button></p>
    {editing ? <div><h2>Editing {editing.agreement_number}.</h2>
      <div className="form-grid">
        <Field label="Monthly rent"><input value={editing.monthly_rent ?? ''} onChange={(e) => setE('monthly_rent', e.target.value)} /></Field>
        <Field label="Rent plan"><select value={editing.rent_plan_id || ''} onChange={(e) => setE('rent_plan_id', e.target.value)}><option value="">None</option>{(plans || []).map((p) => <option key={p.rent_plan_id} value={p.rent_plan_id}>{p.plan_name}</option>)}</select></Field>
        <Field label="Other monthly charges"><input value={editing.other_charges ?? ''} onChange={(e) => setE('other_charges', e.target.value)} /></Field>
        <Field label="Due day (1 to 28)"><input value={editing.due_day ?? ''} onChange={(e) => setE('due_day', e.target.value)} /></Field>
        <Field label="Security deposit"><input value={editing.security_deposit ?? ''} onChange={(e) => setE('security_deposit', e.target.value)} /></Field>
        <Field label="Late fee"><input value={editing.late_fee ?? ''} onChange={(e) => setE('late_fee', e.target.value)} /></Field>
        <Field label="Notice period (days)"><input value={editing.notice_period_days ?? ''} onChange={(e) => setE('notice_period_days', e.target.value)} /></Field></div>
      <p><button className="primary" onClick={async () => {
        try {
          await withBusy('Saving agreement.', async () => api.put(`/api/agreements/${editing.agreement_id}`, {
            monthly_rent: Number(editing.monthly_rent), rent_plan_id: editing.rent_plan_id ? Number(editing.rent_plan_id) : null,
            other_charges: num(editing.other_charges), due_day: Math.min(Math.max(num(editing.due_day, 5), 1), 28),
            security_deposit: num(editing.security_deposit), late_fee: num(editing.late_fee),
            notice_period_days: num(editing.notice_period_days, 30),
          }));
          setEditing(null); setErr(null); setNote('Agreement saved. Future invoices use the new terms.'); load();
        } catch (e) { setErr(e.message); }
      }}>Save changes</button> <button onClick={() => setEditing(null)}>Cancel</button></p></div> : null}
    <table className="grid"><thead><tr><th>No</th><th>Tenant</th><th>Rent</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((a) => <tr key={a.agreement_id}><td>{a.agreement_number}</td><td>{a.tenant_name}</td><td>{money(a.monthly_rent)}</td><td><span className="tag">{a.status}</span></td>
        <td className="row-actions"><button onClick={() => { setEditing({ ...a }); setNote(null); setErr(null); }}>Edit terms</button>{a.status === 'ACTIVE' ? <button onClick={async () => { if (window.confirm(`Terminate agreement ${a.agreement_number}? The room or bed returns to Available.`)) { await withBusy('Terminating agreement.', async () => api.put(`/api/agreements/${a.agreement_id}`, { status: 'TERMINATED', confirm: true })); load(); } }}>Terminate</button> : <button onClick={async () => { await withBusy('Activating agreement.', async () => api.put(`/api/agreements/${a.agreement_id}`, { status: 'ACTIVE' })); load(); }}>Activate</button>}</td></tr>)}</tbody></table>
  </div>);
}
function Invoices() {
  const [list, , load] = useFetch('/api/invoices');
  useFocusReload(load);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7) + '-01');
  const [msg, setMsg] = useState(null);
  const [pay, setPay] = useState({ invoice_id: '', amount: '', payment_mode: 'UPI', payment_reference: '' });
  const [payFiles, setPayFiles] = useState([]);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const openDetail = async (id) => {
    if (sel === id) { setSel(null); setDetail(null); return; }
    setSel(id); setDetail(null);
    try { setDetail(await api.get(`/api/invoices/${id}`)); } catch (e) { setMsg(e.message); }
  };
  const gen = async () => {
    try {
      const r = await withBusy('Generating invoices.', async () => api.post('/api/jobs/generate-rent', { month }));
      setMsg(`Generated ${r.created} invoices, skipped ${r.skipped} duplicates for ${r.month}.`); load();
    } catch (e) { setMsg(e.message); }
  };
  const record = async () => {
    try {
      if (!pay.invoice_id || !(Number(pay.amount) > 0)) { setMsg('Select an invoice and enter an amount greater than 0.'); return; }
      if (!window.confirm(`Record ${money(pay.amount)} against this invoice? Receipt is generated automatically.`)) return;
      await withBusy('Recording payment.', async () => {
        const paths = [];
        for (const fl of payFiles) { paths.push((await uploadFile(fl)).file_path); }
        await api.post('/api/payments', { invoice_id: Number(pay.invoice_id), amount: Number(pay.amount), payment_mode: pay.payment_mode, payment_reference: pay.payment_reference, attachment_paths: paths, confirm: true });
      });
      setMsg('Payment recorded. Invoice totals and receipt updated.'); setPay({ invoice_id: '', amount: '', payment_mode: 'UPI', payment_reference: '' }); setPayFiles([]); load();
    } catch (e) { setMsg(e.message); }
  };
  return (<div><h1>Rent invoices.</h1><p className="sub">One invoice per active agreement per month. Format is INV-YYYYMM-000000.</p>
    <div className="toolbar"><input type="date" value={month} onChange={(e) => setMonth(e.target.value)} /><button className="primary" onClick={gen}>Generate month</button>
      <button onClick={async () => { await withBusy('Marking overdue.', async () => api.post('/api/jobs/mark-overdue', {})); setMsg('Overdue invoices marked.'); load(); }}>Mark overdue</button></div>
    {msg ? <div className="notice">{msg}</div> : null}
    <h2>Record payment.</h2>
    <div className="form-grid">
      <Field label="Invoice"><select value={pay.invoice_id} onChange={(e) => setPay({ ...pay, invoice_id: e.target.value })}><option value="">Select</option>{(list || []).filter((i) => i.outstanding_amount > 0).map((i) => <option key={i.invoice_id} value={i.invoice_id}>{i.invoice_number} ({money(i.outstanding_amount)} due)</option>)}</select></Field>
      <Field label="Amount"><input value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
      <Field label="Mode"><select value={pay.payment_mode} onChange={(e) => setPay({ ...pay, payment_mode: e.target.value })}><option>UPI</option><option>CASH</option><option>CHEQUE</option><option>NET_BANKING</option><option>CREDIT_CARD</option><option>DEBIT_CARD</option><option>BANK_TRANSFER</option></select></Field>
      <Field label="Reference"><input value={pay.payment_reference} onChange={(e) => setPay({ ...pay, payment_reference: e.target.value })} /></Field>
      <Field label="Proof images (UPI screenshot, optional)"><input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" multiple onChange={(e) => setPayFiles(Array.from(e.target.files || []))} /></Field></div>
    <p><button className="primary" onClick={record}>Record payment</button></p>
    <table className="grid"><thead><tr><th>Number</th><th>Tenant</th><th>Month</th><th>Due</th><th>Total</th><th>Paid</th><th>Due bal</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      {(list || []).map((i) => <tr key={i.invoice_id}><td>{i.invoice_number}</td><td>{i.tenant_name}</td><td>{fmtDate(i.invoice_month)}</td><td>{fmtDate(i.due_date)}</td><td>{money(i.total_amount)}</td><td>{money(i.paid_amount)}</td><td>{money(i.outstanding_amount)}</td><td>{i.status === 'OVERDUE' ? <span className="tag overdue">OVERDUE</span> : <span className="tag">{i.status}</span>}</td><td><button onClick={() => openDetail(i.invoice_id)}>{sel === i.invoice_id ? 'Hide' : 'View'}</button></td></tr>)}</tbody></table>
    {detail ? <div><h2>Invoice {detail.invoice_number}: line items, payments, receipts.</h2>
      {detail.source ? <p className="sub">Built from agreement {detail.source.agreement_number} (rent {money(detail.source.monthly_rent)}{Number(detail.source.other_charges) > 0 ? `, other ${money(detail.source.other_charges)}` : ''}{detail.source.plan ? `, plan ${detail.source.plan.plan_name} with maintenance ${money(detail.source.plan.maintenance_charge)} and water ${money(detail.source.plan.water_charge)}` : ', no rent plan linked'}). Edit the agreement or plan, then rebuild this invoice while it is still unpaid.</p>
        : <p className="sub">Source agreement not found.</p>}
      {detail.status === 'PENDING' && Number(detail.paid_amount) === 0 ? <p><button onClick={async () => {
        if (!window.confirm(`Rebuild ${detail.invoice_number} from current agreement and plan values? The current line items are discarded.`)) return;
        try {
          await withBusy('Rebuilding invoice.', async () => api.post(`/api/invoices/${detail.invoice_id}/regenerate`, { confirm: true }));
          setMsg('Invoice rebuilt from current values.'); setDetail(null); setSel(null); load();
        } catch (e) { setMsg(e.message); }
      }}>Rebuild from current values</button></p> : null}
      <table className="grid"><thead><tr><th>Item</th><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>
        {(detail.items || []).map((it) => <tr key={it.invoice_item_id}><td>{it.item_type}</td><td>{it.description}</td><td>{it.quantity}</td><td>{money(it.rate)}</td><td>{money(it.amount)}</td></tr>)}</tbody></table>
      <table className="grid"><thead><tr><th>Payment</th><th>Amount</th><th>Mode</th><th>Status</th><th>Proof</th><th>Receipt</th></tr></thead><tbody>
        {(detail.payments || []).map((p) => {
          const r = (detail.receipts || []).find((x) => x.payment_id === p.payment_id);
          return <tr key={p.payment_id}><td>{p.payment_reference || p.payment_id}</td><td>{money(p.amount)}</td><td>{p.payment_mode}</td><td>{p.status}</td><td>{(p.attachments || []).length ? p.attachments.map((a) => <span key={a.document_id}><a href={fileUrl(a.file_path)} target="_blank" rel="noreferrer">{a.file_name}</a> </span>) : '-'}</td><td>{r ? <Link to={`/admin/receipt/${r.receipt_id}`}>{r.receipt_number}</Link> : '-'}</td></tr>;
        })}</tbody></table></div> : null}
  </div>);
}
function Payments() {
  const [list] = useFetch('/api/payments');
  const [rc] = useFetch('/api/receipts');
  return (<div><h1>Payments and receipts.</h1><p className="sub">Every SUCCESS payment creates a receipt. Invoices reach PAID only through payment rows.</p>
    <h2>Receipts.</h2>
    <table className="grid"><thead><tr><th>Receipt</th><th>Tenant</th><th>Amount</th><th>Date</th><th>Action</th></tr></thead><tbody>
      {(rc || []).map((r) => <tr key={r.receipt_id}><td>{r.receipt_number}</td><td>{r.tenant_name}</td><td>{money(r.amount)}</td><td>{fmtDate(r.receipt_date)}</td><td><Link className="btn" to={`/admin/receipt/${r.receipt_id}`}>View and print</Link></td></tr>)}</tbody></table>
    <h2>Payments.</h2>
    <table className="grid"><thead><tr><th>ID</th><th>Tenant</th><th>Amount</th><th>Mode</th><th>Status</th><th>Ref</th></tr></thead><tbody>
      {(list || []).map((p) => <tr key={p.payment_id}><td>{p.payment_id}</td><td>{p.tenant_name}</td><td>{money(p.amount)}</td><td>{p.payment_mode}</td><td><span className="tag">{p.status}</span></td><td>{p.payment_reference}</td></tr>)}</tbody></table>
  </div>);
}
function ReceiptView({ base }) {
  const { id } = useParams();
  const [d, err] = useFetch(`${base}/receipts/${id}`);
  if (err) return <div className="field-err">{err}</div>;
  if (!d) return <p>Loading receipt.</p>;
  const rows = [
    ['Organization', d.organization?.organization_name],
    ['Property', d.property?.property_name],
    ['Tenant', d.tenant?.full_name],
    ['Invoice', d.invoice ? `${d.invoice.invoice_number} (${fmtDate(d.invoice.invoice_month)})` : ''],
    ['Payment mode', d.payment?.payment_mode],
    ['Payment reference', d.payment?.payment_reference || '-'],
    ['Payment date', fmtDate(d.payment?.payment_date)],
  ];
  return (<div><div className="toolbar noprint"><button onClick={() => window.history.back()}>Back</button><button className="primary" onClick={() => window.print()}>Print or save PDF</button></div>
    <div className="receipt">
      <h1>Rent receipt.</h1>
      <p className="sub">{d.receipt.receipt_number} dated {fmtDate(d.receipt.receipt_date)}</p>
      <table className="grid"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
      <div className="kpi" style={{ border: '1px solid var(--line-dark)', marginTop: 8 }}><div className="l">Amount received</div><div className="n">{money(d.receipt.amount)}</div></div>
      <p className="sub">Generated automatically on payment. Invoice {d.invoice?.invoice_number} now shows {money(d.invoice?.paid_amount)} paid, {money(d.invoice?.outstanding_amount)} outstanding.</p>
    </div></div>);
}
function AdminComplaints() {
  const [list, , load] = useFetch('/api/complaints');
  const [files, setFiles] = useState(null);
  const showFiles = async (c) => {
    if (files && files.id === c.complaint_id) { setFiles(null); return; }
    const d = await api.get(`/api/complaints/${c.complaint_id}`);
    setFiles({ id: c.complaint_id, items: d.attachments || [] });
  };
  const adv = async (c) => {
    const flow = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
    const nxt = flow[flow.indexOf(c.status) + 1];
    if (!nxt) return;
    await withBusy('Updating complaint.', async () => api.put(`/api/complaints/${c.complaint_id}`, { status: nxt }));
    load();
  };
  return (<div><h1>Complaints.</h1><p className="sub">Flow is Open, Assigned, In Progress, Resolved, Closed. Steps only move forward.</p>
    <table className="grid"><thead><tr><th>No</th><th>Tenant</th><th>Category</th><th>Title</th><th>Files</th><th>Status</th><th>Action</th></tr></thead><tbody>
      {(list || []).map((c) => <tr key={c.complaint_id}><td>{c.complaint_number}</td><td>{c.tenant_name}</td><td>{c.category}</td><td>{c.title}</td><td>{c.files ? <button onClick={() => showFiles(c)}>{c.files} file(s)</button> : 0}</td><td><span className="tag">{c.status}</span></td><td><button onClick={() => adv(c)}>Advance</button></td></tr>)}</tbody></table>
    {files ? <div><h2>Attachments for complaint {files.id}.</h2>
      <table className="grid"><thead><tr><th>File</th><th>Open</th></tr></thead><tbody>
        {files.items.map((a) => <tr key={a.document_id}><td>{a.file_name}</td><td><a href={fileUrl(a.file_path)} target="_blank" rel="noreferrer">Open</a></td></tr>)}
      </tbody></table></div> : null}
  </div>);
}
function Audit() {
  const [list] = useFetch('/api/audit-logs');
  const [logs] = useFetch('/api/message-logs');
  return (<div><h1>Audit log.</h1><p className="sub">Every financial or tenant data change is recorded with user, action and timestamp.</p>
    <table className="grid"><thead><tr><th>When</th><th>User</th><th>Module</th><th>Action</th><th>Entity</th></tr></thead><tbody>
      {(list || []).map((a) => <tr key={a.audit_id}><td>{a.created_at}</td><td>{a.user_id}</td><td>{a.module_name}</td><td>{a.action}</td><td>{a.entity_type} {a.entity_id}</td></tr>)}</tbody></table>
    <h2>Mail delivery.</h2><p className="sub">SENT reached the mailbox. PENDING means mail is not configured (set SMTP on the server). FAILED carries the provider reason.</p>
    <table className="grid"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      {((logs && logs.emails) || []).map((e) => <tr key={e.email_id}><td>{e.sent_at}</td><td>{e.email_address}</td><td>{e.subject}</td><td><span className="tag">{e.status}</span></td><td>{e.response}</td></tr>)}</tbody></table>
    <h2>Text delivery.</h2>
    <table className="grid"><thead><tr><th>When</th><th>To</th><th>Status</th><th>Detail</th></tr></thead><tbody>
      {((logs && logs.sms) || []).map((s) => <tr key={s.sms_id}><td>{s.sent_at}</td><td>{s.mobile}</td><td><span className="tag">{s.status}</span></td><td>{s.response}</td></tr>)}</tbody></table>
  </div>);
}

/* ---------- tenant ---------- */
function TenantLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  return (<div><div className="topbar"><span className="brand">Rent Ledger. Tenant.</span>
    <span className="actions"><span className="sub">Signed in</span> <button onClick={() => { if (window.confirm('Sign out now?')) logout(nav); }}>Sign out</button></span></div>
    <div className="tenant-wrap"><nav className="segnav">
      <NavLink to="/tenant" end>Home</NavLink><NavLink to="/tenant/rent">Rent</NavLink><NavLink to="/tenant/complaints">Complaints</NavLink><NavLink to="/tenant/docs">Documents</NavLink><NavLink to="/tenant/notices">Notices</NavLink>
    </nav><div key={loc.pathname} className="page"><Routes>
      <Route index element={<THome />} /><Route path="rent" element={<TRent />} /><Route path="complaints" element={<TComplaints />} /><Route path="docs" element={<TDocs />} /><Route path="notices" element={<TNotices />} /><Route path="receipt/:id" element={<ReceiptView base="/api/tenant" />} />
    </Routes></div></div></div>);
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
  const [from, setFrom] = useState(() => new Date().getFullYear() + '-01-01');
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [stmt, setStmt] = useState(null);
  const loadStmt = async () => { try { setStmt(await withBusy('Loading statement.', async () => api.get(`/api/tenant/statement?from=${from}&to=${to}`))); } catch (e) { setStmt({ error: e.message }); } };
  useEffect(() => { loadStmt(); }, []);
  return (<div><h1>Rent and receipts.</h1><p className="sub">Current invoice first, then history. Payment is recorded by the office in v1.</p>
    <h2>Current and past invoices.</h2>
    <table className="grid"><thead><tr><th>Number</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th></tr></thead><tbody>
      {(inv || []).map((i) => <tr key={i.invoice_id}><td>{i.invoice_number}</td><td>{fmtDate(i.due_date)}</td><td>{money(i.total_amount)}</td><td>{money(i.paid_amount)}</td><td>{i.status === 'OVERDUE' ? <span className="tag overdue">OVERDUE by record</span> : <span className="tag">{i.status}</span>}</td></tr>)}</tbody></table>
    <h2>Payment history.</h2>
    <table className="grid"><thead><tr><th>Receipt</th><th>Amount</th><th>Date</th><th>Action</th></tr></thead><tbody>
      {(pay || []).map((p) => <tr key={p.payment_id}><td>{p.receipt_number || '-'}</td><td>{money(p.amount)}</td><td>{fmtDate(p.payment_date)}</td><td>{p.receipt_id ? <Link className="btn" to={`/tenant/receipt/${p.receipt_id}`}>View and print</Link> : null}</td></tr>)}</tbody></table>
    <h2>Ledger statement.</h2>
    <div className="toolbar"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /><button onClick={loadStmt}>Load</button></div>
    <table className="grid"><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Billed</th><th>Paid</th></tr></thead><tbody>
      {(Array.isArray(stmt) ? stmt : []).map((s, k) => <tr key={k}><td>{fmtDate(s.transaction_date)}</td><td>{s.transaction_type}</td><td>{s.reference_no}</td><td>{s.debit ? money(s.debit) : '-'}</td><td>{s.credit ? money(s.credit) : '-'}</td></tr>)}</tbody></table>
  </div>);
}
function TComplaints() {
  const [me] = useFetch('/api/tenant/me');
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ category: 'PLUMBING', title: '', description: '' });
  const [file, setFile] = useState(null);
  const [msg, setMsg] = useState(null);
  const loadList = async () => {
    try { setRows(await withBusy('Loading complaints.', async () => api.get('/api/complaints'))); }
    catch (e) { setMsg(e.message); }
  };
  useEffect(() => { if (me) loadList(); }, [me]);
  return (<div><h1>Complaints.</h1><p className="sub">File a complaint and track it to closure.</p>
    <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option>ELECTRICITY</option><option>WATER</option><option>PLUMBING</option><option>AC</option><option>FURNITURE</option><option>INTERNET</option><option>CLEANING</option><option>SECURITY</option><option>OTHER</option></select></Field>
    <Field label="Title" error={need(f.title)}><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
    <Field label="Description"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    <Field label="Photo (JPG, PNG, WEBP or PDF, optional)"><input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.mp4" onChange={(e) => setFile(e.target.files[0] || null)} /></Field>
    {msg ? <div className="notice">{msg}</div> : null}
    <p><button className="primary" onClick={async () => {
      try {
        if (need(f.title)) { setMsg('Title is required.'); return; }
        await withBusy(file ? 'Uploading photo and filing.' : 'Filing complaint.', async () => {
          let attachment_path = null;
          if (file) attachment_path = (await uploadFile(file)).file_path;
          await api.post('/api/complaints', { property_id: me.agreement?.property_id, category: f.category, title: f.title, description: f.description, attachment_path });
        });
        setMsg('Complaint filed.'); setF({ category: 'PLUMBING', title: '', description: '' }); setFile(null); loadList();
      } catch (e) { setMsg(e.message); }
    }}>File complaint</button></p>
    <table className="grid"><thead><tr><th>No</th><th>Title</th><th>Status</th><th>Files</th></tr></thead><tbody>
      {rows.map((c) => <tr key={c.complaint_id}><td>{c.complaint_number}</td><td>{c.title}</td><td><span className="tag">{c.status}</span></td><td>{c.files || 0}</td></tr>)}</tbody></table>
  </div>);
}
function TDocs() {
  const [d, , load] = useFetch('/api/tenant/documents');
  const [up, setUp] = useState({ document_type: 'AADHAAR', document_number: '' });
  const [file, setFile] = useState(null);
  const [msg, setMsg] = useState(null);
  if (!d) return <p>Loading.</p>;
  return (<div><h1>Documents.</h1><p className="sub">Agreement, KYC record and uploaded ID proofs.</p>
    <p>KYC status: <span className="tag">{d.kyc?.status || 'KYC_PENDING'}</span></p>
    <h2>Upload a document.</h2>
    <div className="form-grid">
      <Field label="Type"><select value={up.document_type} onChange={(e) => setUp({ ...up, document_type: e.target.value })}><option>AADHAAR</option><option>PAN</option><option>PASSPORT</option><option>DRIVING_LICENSE</option><option>ADDRESS_PROOF</option><option>EMPLOYMENT_PROOF</option><option>PHOTO</option><option>OTHER</option></select></Field>
      <Field label="Number"><input value={up.document_number} onChange={(e) => setUp({ ...up, document_number: e.target.value })} /></Field></div>
    <Field label="File"><input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={(e) => setFile(e.target.files[0] || null)} /></Field>
    {msg ? <div className="notice">{msg}</div> : null}
    <p><button className="primary" onClick={async () => {
      try {
        if (!file) { setMsg('Pick a file first.'); return; }
        await withBusy('Uploading document.', async () => {
          const r = await uploadFile(file);
          await api.post('/api/tenant/documents', { document_type: up.document_type, document_number: up.document_number || null, file_path: r.file_path });
        });
        setMsg('Uploaded. The office will verify it.'); setFile(null); load();
      } catch (e) { setMsg(e.message); }
    }}>Upload</button></p>
    <h2>Agreements.</h2><table className="grid"><thead><tr><th>No</th><th>Status</th><th>Period</th></tr></thead><tbody>
      {(d.agreements || []).map((a) => <tr key={a.agreement_id}><td>{a.agreement_number}</td><td>{a.status}</td><td>{fmtDate(a.start_date)} to {fmtDate(a.end_date)}</td></tr>)}</tbody></table>
    <h2>ID documents.</h2><table className="grid"><thead><tr><th>Type</th><th>Status</th><th>File</th></tr></thead><tbody>
      {(d.documents || []).map((x) => <tr key={x.tenant_document_id}><td>{x.document_type}</td><td>{x.verification_status}</td><td>{x.file_path && x.file_path.startsWith('/files/') ? <a href={fileUrl(x.file_path)} target="_blank" rel="noreferrer">Open</a> : (x.file_path || '-')}</td></tr>)}</tbody></table>
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
  // Tenants stay in the tenant app; staff stay in admin. This stops
  // confusing permission errors from cross opened URLs.
  const mine = localStorage.getItem('prm_role');
  if (role === 'staff' && mine === 'tenant') return <Navigate to="/tenant" />;
  if (role === 'tenant' && mine !== 'tenant') return <Navigate to="/admin" />;
  return children;
}
export default function App() {
  return (<BrowserRouter><BusyOverlay /><Routes>
    <Route path="/login" element={<AdminLogin />} />
    <Route path="/tenant/login" element={<TenantLogin />} />
    <Route path="/admin/*" element={<Guard role="staff"><AdminLayout /></Guard>} />
    <Route path="/tenant/*" element={<Guard role="tenant"><TenantLayout /></Guard>} />
    <Route path="/" element={<Navigate to={(localStorage.getItem('prm_role') === 'tenant') ? '/tenant' : '/admin'} />} />
  </Routes></BrowserRouter>);
}
