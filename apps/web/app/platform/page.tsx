'use client';

import { useEffect, useState } from 'react';

type Tenant = { id: string; name: string; slug: string; status: string; created_at: string };

async function platformApi(path: string, secret: string, opts: RequestInit = {}) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000/api/v1';
  const res = await fetch(`${base}/platform${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Platform-Admin': secret, ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.detail?.message || 'request failed');
  return body;
}

export default function PlatformPage() {
  const [secret, setSecret] = useState('');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<any>(null);

  const [form, setForm] = useState<any>({
    tenant: { name: '', slug: '', timezone: 'UTC', service_days: ['mon', 'tue', 'wed', 'thu', 'fri'], windowA_start: '09:00:00', windowA_end: '12:00:00', windowB_start: '12:00:00', windowB_end: '17:00:00', capacity_per_window: 4 },
    admin_user: { email: '', password: '' },
    channels: [],
    seed_catalog_template: false,
  });

  const loadTenants = async () => setTenants((await platformApi('/tenants', secret)).items || []);
  useEffect(() => {
    if (secret) loadTenants().catch(() => null);
  }, [secret]);

  const loadDetail = async (tenantId: string) => {
    setSelected(tenantId);
    setDetail(await platformApi(`/tenants/${tenantId}`, secret));
    setHealth(await platformApi(`/tenants/${tenantId}/health`, secret));
  };

  return <main style={{ padding: 16 }}>
    <h1>Platform Admin Console</h1>
    <input placeholder="X-Platform-Admin secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
    <button onClick={loadTenants}>Load Tenants</button>

    <h2>Onboarding Wizard</h2>
    <input placeholder="Tenant name" value={form.tenant.name} onChange={(e) => setForm({ ...form, tenant: { ...form.tenant, name: e.target.value } })} />
    <input placeholder="Tenant slug" value={form.tenant.slug} onChange={(e) => setForm({ ...form, tenant: { ...form.tenant, slug: e.target.value } })} />
    <input placeholder="Admin email" value={form.admin_user.email} onChange={(e) => setForm({ ...form, admin_user: { ...form.admin_user, email: e.target.value } })} />
    <input placeholder="Admin password" type="password" value={form.admin_user.password} onChange={(e) => setForm({ ...form, admin_user: { ...form.admin_user, password: e.target.value } })} />
    <label><input type="checkbox" checked={form.seed_catalog_template} onChange={(e) => setForm({ ...form, seed_catalog_template: e.target.checked })} /> Seed catalog template</label>
    <button onClick={async () => setOnboarding(await platformApi('/onboarding', secret, { method: 'POST', body: JSON.stringify(form) }))}>Create Tenant</button>
    {onboarding && <pre>{JSON.stringify(onboarding, null, 2)}</pre>}

    <h2>Tenants</h2>
    <ul>{tenants.map((t) => <li key={t.id}><button onClick={() => loadDetail(t.id)}>{t.name}</button> ({t.slug}) - {t.status}</li>)}</ul>

    {selected && <section>
      <h3>Tenant Detail</h3>
      <pre>{JSON.stringify(detail, null, 2)}</pre>
      <h3>Health Summary</h3>
      <pre>{JSON.stringify(health, null, 2)}</pre>
    </section>}
  </main>;
}
