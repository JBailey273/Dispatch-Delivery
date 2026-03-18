'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, requireRole } from '../../lib/auth';

type ChannelItem = { id: string; name: string; type: string; status: string; last_call_at?: string | null };
type ChannelUsage = { channel_id: string; last_request_at?: string | null; recent_error_count: number };
type WcForm = { wc_store_url: string; wc_consumer_key: string; wc_consumer_secret: string };

const TYPE_LABEL: Record<string, string> = { manual: 'Manual', woocommerce: 'WooCommerce' };
const [wcModal, setWcModal] = useState<ChannelItem | null>(null);
const [wcForm, setWcForm] = useState<WcForm>({ wc_store_url: '', wc_consumer_key: '', wc_consumer_secret: '' });
const [wcSaving, setWcSaving] = useState(false);

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', type: 'woocommerce' });
  const [saving, setSaving] = useState(false);

  // Key reveal
  const [revealedKey, setRevealedKey] = useState<{ channelName: string; key: string } | null>(null);

  // Usage
  const [usageModal, setUsageModal] = useState<{ channel: ChannelItem; usage: ChannelUsage } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/channels');
      setChannels(data.items || []);
    } catch (err) { setError((err as ApiError).message || 'Failed to load channels'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createChannel = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api('/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createForm) });
      setRevealedKey({ channelName: createForm.name, key: res.api_key });
      setShowCreate(false);
      setCreateForm({ name: '', type: 'woocommerce' });
      load();
    } catch (err) { setError((err as ApiError).message || 'Create failed'); }
    finally { setSaving(false); }
  };

  const rotateKey = async (c: ChannelItem) => {
    if (!confirm(`Rotate API key for "${c.name}"?\n\nThe old key will immediately stop working.`)) return;
    setError('');
    try {
      const res = await api(`/channels/${c.id}/rotate-key`, { method: 'POST' });
      setRevealedKey({ channelName: c.name, key: res.api_key });
    } catch (err) { setError((err as ApiError).message || 'Rotate failed'); }
  };

  const disableChannel = async (c: ChannelItem) => {
    if (!confirm(`Disable channel "${c.name}"?`)) return;
    setError('');
    try {
      await api(`/channels/${c.id}/disable`, { method: 'POST' });
      setSuccess(`Channel "${c.name}" disabled`);
      load();
    } catch (err) { setError((err as ApiError).message || 'Disable failed'); }
  };

  const showUsage = async (c: ChannelItem) => {
    try {
      const usage = await api(`/channels/${c.id}/usage`);
      setUsageModal({ channel: c, usage });
    } catch (err) { setError((err as ApiError).message || 'Failed to load usage'); }
  };

  const saveWcCredentials = async () => {
    if (!wcModal) return;
    setWcSaving(true);
    setError('');
    try {
      await api(`/channels/${wcModal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wcForm),
      });
      setSuccess('WooCommerce credentials saved');
      setWcModal(null);
    } catch (err) {
      setError((err as ApiError).message || 'Save failed');
    } finally {
      setWcSaving(false);
    }
  };

  
  if (!requireRole(['admin'])) return <div className="page"><p>Unauthorized</p></div>;

  return (
    <>
      <style>{styles}</style>
      <div className="page ch-page">
        <div className="ch-top">
          <div>
            <h1>Channels</h1>
            <p style={{ color: 'var(--gray-500)', marginTop: 2 }}>Manage external order integrations</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ New Channel</button>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <span>⚠</span> {error}
            <button className="btn btn-ghost btn-sm" onClick={() => setError('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}
        {success && (
          <div className="alert alert-success" style={{ marginBottom: 12 }}>
            <span>✓</span> {success}
            <button className="btn btn-ghost btn-sm" onClick={() => setSuccess('')} style={{ marginLeft: 'auto' }}>✕</button>
          </div>
        )}

        {/* Key reveal banner */}
        {revealedKey && (
          <div className="alert alert-warning" style={{ marginBottom: 16, flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <span>🔑</span>
              <strong style={{ flex: 1 }}>API Key for "{revealedKey.channelName}" — copy now, it won't be shown again</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setRevealedKey(null)}>✕</button>
            </div>
            <div className="ch-key-box">
              <code>{revealedKey.key}</code>
              <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(revealedKey.key); setSuccess('Copied to clipboard'); }}>Copy</button>
            </div>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner spinner-lg" style={{ margin: '0 auto' }} />
          </div>
        )}

        {!loading && channels.length === 0 && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">🔌</div>
              <div className="empty-state-title">No channels yet</div>
              <div className="empty-state-desc">Create a channel to connect WooCommerce or other order sources.</div>
            </div>
          </div>
        )}

        {!loading && channels.length > 0 && (
          <div className="ch-grid">
            {channels.map(c => (
              <div key={c.id} className="card ch-card">
                <div className="ch-card-top">
                  <div className="ch-card-icon">{c.type === 'woocommerce' ? '🛒' : '📡'}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--gray-900)' }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--gray-500)', marginTop: 2 }}>{TYPE_LABEL[c.type] || c.type}</div>
                  </div>
                  {c.status === 'active'
                    ? <span className="pill pill-green"><span className="pill-dot" />Active</span>
                    : <span className="pill pill-gray">Disabled</span>
                  }
                </div>
                <div className="ch-card-meta">
                  <div className="ch-meta-item">
                    <span className="ch-meta-label">Last Call</span>
                    <span className="ch-meta-value">{c.last_call_at ? new Date(c.last_call_at).toLocaleString() : 'Never'}</span>
                  </div>
                  <div className="ch-meta-item">
                    <span className="ch-meta-label">Channel ID</span>
                    <span className="ch-meta-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.id.slice(0, 12)}…</span>
                  </div>
                </div>
                <div className="ch-card-actions">
                  {c.type === 'woocommerce' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setWcForm({ wc_store_url: '', wc_consumer_key: '', wc_consumer_secret: '' });
                        setWcModal(c);
                      }}
                    >
                      ⚙ Configure
                    </button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => showUsage(c)}>Usage</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => rotateKey(c)}>Rotate Key</button>
                  {c.status === 'active' && (
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => disableChannel(c)}>Disable</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <div className="modal-overlay" onClick={() => setShowCreate(false)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>New Channel</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Channel Name</label>
                  <input
                    value={createForm.name}
                    onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="My WooCommerce Store"
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Type</label>
                  <select value={createForm.type} onChange={e => setCreateForm(f => ({ ...f, type: e.target.value }))}>
                    <option value="woocommerce">WooCommerce</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={createChannel} disabled={saving || !createForm.name.trim()}>
                  {saving ? 'Creating…' : 'Create Channel'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Usage modal */}
        {usageModal && (
          <div className="modal-overlay" onClick={() => setUsageModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Channel Usage — {usageModal.channel.name}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setUsageModal(null)}>✕</button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last Request</div>
                    <div style={{ fontSize: 15, fontWeight: 500, marginTop: 4 }}>
                      {usageModal.usage.last_request_at ? new Date(usageModal.usage.last_request_at).toLocaleString() : 'Never'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Recent Errors</div>
                    <div style={{ fontSize: 15, fontWeight: 500, marginTop: 4, color: usageModal.usage.recent_error_count > 0 ? 'var(--red-600)' : 'var(--green-600)' }}>
                      {usageModal.usage.recent_error_count}
                    </div>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setUsageModal(null)}>Close</button>
              </div>
            </div>
          </div>
        )}

        {/* WooCommerce credentials modal */}
        {wcModal && (
          <div className="modal-overlay" onClick={() => setWcModal(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Configure — {wcModal.name}</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => setWcModal(null)}>✕</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, color: 'var(--gray-500)', marginTop: 0 }}>
                  Enter your WooCommerce store URL and REST API credentials. These are used to sync order status back to WooCommerce when orders are fulfilled or delivered.
                </p>
                <div className="form-group">
                  <label className="form-label">Store URL</label>
                  <input
                    value={wcForm.wc_store_url}
                    onChange={e => setWcForm(f => ({ ...f, wc_store_url: e.target.value }))}
                    placeholder="https://yourstore.com"
                    autoFocus
                  />
                  <span className="form-hint">Your WooCommerce site root URL, no trailing slash</span>
                </div>
                <div className="form-group">
                  <label className="form-label">Consumer Key</label>
                  <input
                    value={wcForm.wc_consumer_key}
                    onChange={e => setWcForm(f => ({ ...f, wc_consumer_key: e.target.value }))}
                    placeholder="ck_xxxxxxxxxxxxxxxxxxxx"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Consumer Secret</label>
                  <input
                    type="password"
                    value={wcForm.wc_consumer_secret}
                    onChange={e => setWcForm(f => ({ ...f, wc_consumer_secret: e.target.value }))}
                    placeholder="cs_xxxxxxxxxxxxxxxxxxxx"
                  />
                </div>
                <div className="alert alert-info" style={{ marginTop: 4 }}>
                  <span>ℹ</span>
                  <span>Generate credentials in WooCommerce → Settings → Advanced → REST API. Set permissions to <strong>Read/Write</strong>.</span>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => setWcModal(null)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  onClick={saveWcCredentials}
                  disabled={wcSaving || !wcForm.wc_store_url.trim() || !wcForm.wc_consumer_key.trim() || !wcForm.wc_consumer_secret.trim()}
                >
                  {wcSaving ? 'Saving…' : 'Save Credentials'}
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
  .ch-page { max-width: 860px; }
  .ch-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
  .ch-top h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin: 0; }

  .ch-key-box { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 12px; width: 100%; }
  .ch-key-box code { flex: 1; font-size: 13px; word-break: break-all; color: var(--gray-800); }

  .ch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; }
  @media (max-width: 500px) { .ch-grid { grid-template-columns: 1fr; } }

  .ch-card-top { display: flex; align-items: flex-start; gap: 12px; padding: 20px; border-bottom: 1px solid var(--border-light); }
  .ch-card-icon { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--gray-100); display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
  .ch-card-meta { padding: 14px 20px; display: flex; gap: 24px; }
  .ch-meta-item { display: flex; flex-direction: column; gap: 2px; }
  .ch-meta-label { font-size: 11px; font-weight: 700; color: var(--gray-400); text-transform: uppercase; letter-spacing: 0.04em; }
  .ch-meta-value { font-size: 13px; color: var(--gray-700); }
  .ch-card-actions { display: flex; gap: 6px; padding: 12px 20px; border-top: 1px solid var(--border-light); flex-wrap: wrap; }

  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal-card { background: var(--surface); border-radius: var(--radius-lg); box-shadow: 0 20px 60px rgba(0,0,0,0.2); width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 16px; border-bottom: 1px solid var(--border-light); }
  .modal-header h2 { font-size: 18px; font-weight: 800; margin: 0; }
  .modal-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--border-light); }
`;
