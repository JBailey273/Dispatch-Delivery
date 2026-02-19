'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../lib/auth';

type UserItem = { id: string; email: string; role: string; is_active: boolean; default_truck_identifier?: string | null };

const ROLE_PILL: Record<string, string> = { admin: 'pill-blue', dispatcher: 'pill-green', driver: 'pill-amber' };
const ROLE_LABEL: Record<string, string> = { admin: 'Admin', dispatcher: 'Dispatcher', driver: 'Driver' };

export default function UsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Modal
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [form, setForm] = useState({ email: '', password: 'password', role: 'dispatcher', default_truck_identifier: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/users');
      setUsers(data.items || []);
    } catch (err) { setError((err as ApiError).message || 'Failed to load users'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ email: '', password: 'password', role: 'dispatcher', default_truck_identifier: '' });
    setEditUser(null);
    setModal('create');
  };

  const openEdit = (u: UserItem) => {
    setForm({ email: u.email, password: '', role: u.role, default_truck_identifier: u.default_truck_identifier || '' });
    setEditUser(u);
    setModal('edit');
  };

  const saveUser = async () => {
    setSaving(true);
    setError('');
    try {
      if (modal === 'edit' && editUser) {
        const updates: any = { role: form.role, default_truck_identifier: form.default_truck_identifier || null };
        await api(`/users/${editUser.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
        setSuccess('User updated');
      } else {
        await api('/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
        setSuccess('User created');
      }
      setModal(null);
      load();
    } catch (err) { setError((err as ApiError).message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const toggleActive = async (u: UserItem) => {
    setError('');
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !u.is_active }) });
      load();
    } catch (err) { setError((err as ApiError).message || 'Update failed'); }
  };

  const deleteUser = async (u: UserItem) => {
    if (!confirm(`Delete user ${u.email}? This cannot be undone.`)) return;
    setError('');
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      setSuccess(`User ${u.email} deleted`);
      load();
    } catch (err) { setError((err as ApiError).message || 'Delete failed'); }
  };

  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  const activeCount = users.filter(u => u.is_active).length;
  const driverCount = users.filter(u => u.role === 'driver' && u.is_active).length;

  return (
    <>
      <style>{styles}</style>
      <div className="page usr-page">
        <div className="usr-top">
          <div>
            <h1>Users</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>{activeCount} active · {driverCount} driver{driverCount !== 1 ? 's' : ''}</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Add User</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span>⚠</span> {error} <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button></div>}
        {success && <div className="alert alert-success" style={{ marginBottom: 12 }}><span>✓</span> {success} <button className="btn btn-ghost btn-sm" onClick={() => setSuccess('')} style={{ marginLeft: 'auto' }}>✕</button></div>}

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>}

        {!loading && users.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <div className="empty-state-title">No users yet</div>
              <div className="empty-state-desc">Create your first user to get started.</div>
            </div>
          </div>
        )}

        {!loading && users.length > 0 && (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Truck ID</th>
                  <th>Status</th>
                  <th style={{ width: 160 }}></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="usr-avatar">{u.email?.charAt(0)?.toUpperCase() || '?'}</div>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{u.email}</div>
                          <div style={{ fontSize: 12, color: 'var(--gray-400)', fontFamily: 'var(--font-mono)' }}>{u.id.slice(0, 8)}…</div>
                        </div>
                      </div>
                    </td>
                    <td><span className={`pill ${ROLE_PILL[u.role] || 'pill-gray'}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                    <td>{u.default_truck_identifier ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{u.default_truck_identifier}</span> : <span style={{ color: 'var(--gray-300)' }}>—</span>}</td>
                    <td>
                      {u.is_active
                        ? <span className="pill pill-green"><span className="pill-dot" />Active</span>
                        : <span className="pill pill-gray">Disabled</span>
                      }
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>Edit</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u)}>
                          {u.is_active ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => deleteUser(u)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create/Edit modal */}
        {modal && (
          <div className="modal-overlay" onClick={() => setModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{modal === 'edit' ? 'Edit User' : 'Add User'}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="user@example.com" disabled={modal === 'edit'} autoFocus={modal === 'create'} />
                </div>
                {modal === 'create' && (
                  <div className="form-group">
                    <label className="form-label">Password</label>
                    <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">Role</label>
                    <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                      <option value="admin">Admin</option>
                      <option value="dispatcher">Dispatcher</option>
                      <option value="driver">Driver</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Default Truck</label>
                    <input value={form.default_truck_identifier} onChange={e => setForm(f => ({ ...f, default_truck_identifier: e.target.value }))} placeholder="e.g. Truck-01" />
                    <span className="form-hint">For drivers only</span>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveUser} disabled={saving || (modal === 'create' && !form.email)}>
                  {saving ? 'Saving…' : modal === 'edit' ? 'Update' : 'Create User'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const styles = `
  .usr-page { max-width: 900px; }
  .usr-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .usr-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
  .usr-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--blue-50); color: var(--blue-700); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0; }
`;
