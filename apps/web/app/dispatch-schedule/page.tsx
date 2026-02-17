'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api, requireRole } from '../lib/auth';

type Suggestion = {
  suggestion_type: string;
  explanation: string;
  why: string;
  data_used: string[];
  referenced_entities: Record<string, any>;
  confidence: 'low' | 'medium' | 'high';
};

type OptimizationProposal = {
  proposal_id: string;
  proposal_type: 'REORDER' | 'REASSIGN' | 'BALANCE' | 'SPLIT_OPTION';
  affected_load_ids: string[];
  before_state: Record<string, any>;
  after_state: Record<string, any>;
  explanation: string;
  estimated_benefit: Record<string, any>;
  confidence_level: 'low' | 'medium' | 'high';
  status: string;
};

export default function DispatchSchedulePage() {
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [schedule, setSchedule] = useState<any>(null);
  const [driver, setDriver] = useState('');
  const [loadIds, setLoadIds] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [proposals, setProposals] = useState<OptimizationProposal[]>([]);
  const [changedLoads, setChangedLoads] = useState<Set<string>>(new Set());
  const [selectedProposalLoads, setSelectedProposalLoads] = useState<Record<string, Set<string>>>({});
  const [lastAppliedProposal, setLastAppliedProposal] = useState<string | null>(null);
  const driverLoadWarningThreshold = 8;

  const load = async () => {
    const [scheduleData, suggestionsData, proposalData] = await Promise.all([
      api(`/dispatch/schedule?day=${day}`),
      api(`/dispatch/suggestions?day=${day}`),
      api(`/dispatch/optimization/proposals?day=${day}&regenerate=true`),
    ]);
    setSchedule(scheduleData);
    setSuggestions(suggestionsData.suggestions || []);
    setProposals((proposalData.proposals || []).filter((p: OptimizationProposal) => p.status !== 'dismissed'));
  };

  useEffect(() => {
    load().catch(() => null);
  }, [day]);

  if (!requireRole(['dispatcher'])) return <p>Unauthorized</p>;

  const visibleSuggestions = useMemo(
    () => suggestions.filter((s) => !dismissed.has(JSON.stringify(s.referenced_entities) + s.suggestion_type)),
    [suggestions, dismissed],
  );

  const dismissSuggestion = async (s: Suggestion) => {
    await api('/dispatch/suggestions/dismissed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion_type: s.suggestion_type, referenced_entities: s.referenced_entities }),
    });
    setDismissed((prev) => new Set(prev).add(JSON.stringify(s.referenced_entities) + s.suggestion_type));
  };

  const applySuggestion = async (s: Suggestion) => {
    if (s.suggestion_type === 'co_assign_nearby_drops') {
      const ids = (s.referenced_entities.load_ids || []) as string[];
      if (driver && ids.length > 0) {
        await api('/dispatch/loads/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ load_ids: ids, driver_user_id: driver }),
        });
      }
    }
    await api('/dispatch/suggestions/applied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion_type: s.suggestion_type, referenced_entities: s.referenced_entities }),
    });
    await load();
  };

  const applyProposal = async (proposal: OptimizationProposal) => {
    const selected = selectedProposalLoads[proposal.proposal_id];
    const selectedLoadIds = selected && selected.size > 0 ? Array.from(selected) : proposal.affected_load_ids;
    await api(`/dispatch/optimization/proposals/${proposal.proposal_id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_load_ids: selectedLoadIds }),
    });
    setChangedLoads(new Set(selectedLoadIds));
    setLastAppliedProposal(proposal.proposal_id);
    await load();
  };

  const undoProposal = async (proposalId: string) => {
    await api(`/dispatch/optimization/proposals/${proposalId}/undo`, { method: 'POST' });
    setChangedLoads(new Set());
    setLastAppliedProposal(null);
    await load();
  };

  const dismissProposal = async (proposalId: string) => {
    await api(`/dispatch/optimization/proposals/${proposalId}/dismiss`, { method: 'POST' });
    await load();
  };

  return (
    <main>
      <h1>Dispatch Schedule</h1>
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} /> <button onClick={load}>Refresh</button>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12, marginBottom: 12 }}>
        <h3>Optimization</h3>
        {proposals.length === 0 && <p style={{ color: '#666' }}>No optimization proposals right now.</p>}
        {proposals.map((proposal) => (
          <article key={proposal.proposal_id} style={{ border: '1px solid #eee', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>{proposal.proposal_type}</strong>: {proposal.explanation}
            </p>
            <p style={{ margin: '6px 0', fontSize: 12 }}>
              Before: {JSON.stringify(proposal.before_state)} → After: {JSON.stringify(proposal.after_state)}
            </p>
            <p style={{ margin: '6px 0', fontSize: 12 }}>Estimated benefit: {JSON.stringify(proposal.estimated_benefit)}</p>
            {proposal.confidence_level === 'low' && <p style={{ color: '#a15c00', margin: '6px 0' }}>Low confidence suggestion: please verify manually.</p>}
            <details>
              <summary>Partial apply</summary>
              {proposal.affected_load_ids.map((id) => (
                <label key={id} style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    checked={selectedProposalLoads[proposal.proposal_id]?.has(id) || false}
                    onChange={(e) => {
                      setSelectedProposalLoads((prev) => {
                        const next = { ...prev };
                        const set = new Set(next[proposal.proposal_id] || proposal.affected_load_ids);
                        if (e.target.checked) set.add(id);
                        else set.delete(id);
                        next[proposal.proposal_id] = set;
                        return next;
                      });
                    }}
                  />
                  {id}
                </label>
              ))}
            </details>
            <button onClick={() => applyProposal(proposal)} style={{ marginRight: 8 }}>
              Apply
            </button>
            <button onClick={() => undoProposal(proposal.proposal_id)} style={{ marginRight: 8 }}>
              Undo
            </button>
            <button onClick={() => dismissProposal(proposal.proposal_id)}>Dismiss</button>
          </article>
        ))}
        {lastAppliedProposal && (
          <button onClick={() => undoProposal(lastAppliedProposal)} style={{ marginTop: 8 }}>
            Undo last optimization
          </button>
        )}
      </section>

      <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12, marginBottom: 12 }}>
        <h3>Suggestions</h3>
        {visibleSuggestions.length === 0 && <p style={{ color: '#666' }}>No suggestions right now.</p>}
        {visibleSuggestions.map((s, idx) => (
          <article key={`${s.suggestion_type}-${idx}`} style={{ border: '1px solid #eee', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>{s.explanation}</strong>
            </p>
            <p style={{ margin: '6px 0', fontSize: 13 }}>
              Why: {s.why} <em>(confidence: {s.confidence})</em>
            </p>
            <p style={{ margin: '6px 0', fontSize: 12, color: '#555' }}>Data used: {s.data_used.join(', ')}</p>
            <button onClick={() => applySuggestion(s)} style={{ marginRight: 8 }}>
              Apply
            </button>
            <button onClick={() => dismissSuggestion(s)}>Dismiss</button>
          </article>
        ))}
      </section>

      {schedule &&
        ['A', 'B'].map((w) => (
          <section key={w}>
            <h2>
              Window {w} ({schedule.windows[w].capacity.used}/{schedule.windows[w].capacity.total})
            </h2>
            {Object.entries(schedule.windows[w].groups).map(([k, v]: any) => (
              <div key={k}>
                <h4>{k}</h4>
                <ul>
                  {v.map((l: any, index: number) => (
                    <li key={l.id} style={{ background: changedLoads.has(l.id) ? '#fff9db' : 'transparent' }}>
                      <label>
                        <input
                          type="checkbox"
                          onChange={(e) => setLoadIds(e.target.checked ? [...loadIds, l.id] : loadIds.filter((id) => id !== l.id))}
                        />{' '}
                        <span style={{ color: '#555', marginRight: 6 }}>#{index + 1}</span>
                        <Link href={`/dispatch/drops/${l.drop_id}`}>Drop</Link> - {l.material} {l.qty}{' '}
                        {l.historical_flags?.has_exception_history && (
                          <span
                            title={`Past exceptions: ${l.historical_flags.exception_count}. Notes: ${(l.historical_flags.recent_notes || []).join(' | ') || 'none'}`}
                            style={{ color: '#a15c00' }}
                          >
                            ⚠️
                          </span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}

      <input placeholder="driver user id" value={driver} onChange={(e) => setDriver(e.target.value)} />
      {loadIds.length > driverLoadWarningThreshold && (
        <p style={{ color: 'orange' }}>Warning: assigning more than {driverLoadWarningThreshold} loads at once to one driver can increase risk.</p>
      )}
      <button
        onClick={async () => {
          await api('/dispatch/loads/assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ load_ids: loadIds, driver_user_id: driver }),
          });
          await load();
        }}
      >
        Assign selected
      </button>
    </main>
  );
}
