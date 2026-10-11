import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { deriveLiveFlow, type FlowStep } from './flow-state';
import './style.css';

type Event = { seq: number; at: string; phase: string; kind: string; message: string; data?: Record<string, unknown> };
type Ready = { database: boolean; memoryIndex: boolean; storage: string; agents: string; model: string; liveReady: boolean; raindropConfigured: boolean };
type Session = { id: string; fault: string; customerId: string };
type Case = { id: string; passed: boolean; category: string; detail: string };
type Evaluation = { id: string; passed: boolean; results: Case[] };
type Episode = { id: string; summary: string; score?: number; source: string };
type Evidence = { run: { status: string; baselineClaim?: string; baselineVerified?: boolean; improvedClaim?: string; improvedVerified?: boolean }; customer: { name: string; entitlementActive: boolean }; payment: { id: string } | null; episodes: Episode[]; policies: { id: string; version: string; status: string; explanation: string }[]; evals: Evaluation[]; activeVersion: string };

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body as T;
}

function FlowLane({ label, steps }: { label: string; steps: FlowStep[] }) {
  return <div className="flow-lane"><div className="flow-lane-label">{label}</div><div className="flow-nodes">{steps.map((step, index) => <div className={`flow-node ${step.status}`} key={step.id}><div className="flow-node-top"><span>{step.system}</span><span className="flow-node-state">{step.status === 'issue' ? 'ISSUE' : step.status === 'done' ? 'DONE' : step.status === 'running' ? 'LIVE' : 'WAITING'}</span></div><strong>{step.action}</strong><small>{step.detail}</small>{index < steps.length - 1 && <span className="flow-arrow" aria-hidden="true">→</span>}</div>)}</div></div>;
}

function App() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  useEffect(() => {
    void json<Ready>('/api/ready').then(setReady).catch(error => setError(String(error)));
    const restoreSession = async () => {
      const prior = sessionStorage.getItem('shapiSessionId');
      if (prior) {
        try {
          const restored = await json<{ session: Session }>(`/api/sessions/${prior}`);
          setSession(restored.session);
          const priorRun = sessionStorage.getItem('shapiRunId');
          if (priorRun) setRunId(priorRun);
          return;
        } catch { sessionStorage.removeItem('shapiRunId'); }
      }
      const created = await json<Session>('/api/sessions', { method: 'POST' });
      sessionStorage.setItem('shapiSessionId', created.id);
      setSession(created);
    };
    void restoreSession().catch(error => setError(String(error)));
  }, []);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = message => {
      const event = JSON.parse(message.data) as Event;
      setEvents(previous => previous.some(item => item.seq === event.seq) ? previous : [...previous, event]);
      if (['verified-success', 'escalated', 'error'].includes(event.kind)) {
        source.close(); setBusy(false);
        void json<Evidence>(`/api/runs/${runId}/evidence`).then(setEvidence).catch(error => setError(String(error)));
      }
    };
    source.onerror = () => {
      source.close(); setBusy(false);
      void json<Evidence>(`/api/runs/${runId}/evidence`).then(setEvidence).catch(() => setError('Live event stream disconnected. Refresh the evidence view.'));
    };
    return () => source.close();
  }, [runId]);

  const memories = useMemo(() => {
    const event = events.find(item => item.kind === 'retrieved');
    return (event?.data?.memories ?? []) as Episode[];
  }, [events]);
  const latestEval = useMemo(() => {
    const matches = events.filter(item => item.kind === 'results');
    return matches.at(-1)?.data?.evaluation as Evaluation | undefined;
  }, [events]);
  const engineeredEvals = (events.find(item => item.kind === 'version-results')?.data?.evaluations ?? []) as (Evaluation & { version: string })[];
  const falseSuccess = events.some(event => event.kind === 'false-success');
  const verified = events.some(event => event.kind === 'verified-success');
  const promoted = events.some(event => event.kind === 'promoted');
  const raindropEvents = events.filter(event => event.kind === 'raindrop-recorded');
  const raindropError = events.some(event => event.kind === 'raindrop-error');
  const baselineClaimed = events.some(event => event.phase === 'baseline' && event.kind === 'claim');
  const customerAccess = evidence?.customer.entitlementActive ?? verified;
  const flowSteps = useMemo(() => deriveLiveFlow(events, session?.fault === 'silent'), [events, session?.fault]);

  async function breakProvider() {
    if (!session) return;
    try { setError(null); setSession(await json<Session>(`/api/sessions/${session.id}/fault`, { method: 'POST', body: JSON.stringify({ fault: 'silent' }) })); }
    catch (error) { setError(String(error)); }
  }
  async function start() {
    if (!session) return;
    try {
      setError(null); setBusy(true); setEvents([]); setEvidence(null); setRunId(null);
      const result = await json<{ runId: string }>('/api/demo/runs', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) });
      sessionStorage.setItem('shapiRunId', result.runId);
      setRunId(result.runId);
    } catch (error) { setBusy(false); setError(String(error)); }
  }
  async function reset() {
    try { setError(null); setBusy(false); setRunId(null); setEvents([]); setEvidence(null); setShowEvidence(false); sessionStorage.removeItem('shapiRunId'); const created = await json<Session>('/api/sessions', { method: 'POST' }); sessionStorage.setItem('shapiSessionId', created.id); setSession(created); }
    catch (error) { setError(String(error)); }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-symbol">✳</span><span>SHAPI <small>AGENT HARNESS</small></span></div>
      <div className="top-center">DOES REALITY AGREE?</div>
      <div className="status-group"><span className={`status-dot ${ready?.liveReady ? 'live' : ''}`} />{ready?.liveReady ? 'LIVE ATLAS + MODEL' : ready ? `${ready.storage.toUpperCase()} / ${ready.agents.toUpperCase()}` : 'CONNECTING'}<span className="version-pill">HARNESS {promoted ? 'v3' : 'v2'}</span></div>
    </header>

    <main>
      <section className="hero">
        <div className="eyebrow">THE OUTCOME CONTRACT <span>01 / UPGRADE</span></div>
        <h1>Agents act.<br /><em>SHAPI verifies reality.</em></h1>
        <p>One successful API response can hide a failed customer outcome. Break the provider, run the agent, and watch the harness learn a safer rule.</p>
        <div className="actions">
          <button className="danger" onClick={breakProvider} disabled={!session || busy || session.fault === 'silent'}>{session?.fault === 'silent' ? 'PROVIDER BROKEN ✓' : '✷ BREAK PROVIDER'}</button>
          <button className="primary" onClick={start} disabled={!session || busy || session.fault !== 'silent' || !!runId}>{busy ? ready?.liveReady ? 'RUNNING LIVE…' : 'RUNNING LOCAL…' : 'UPGRADE MAYA →'}</button>
          <button className="ghost" onClick={reset} disabled={busy}>RESET DEMO</button>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        {!ready?.liveReady && ready && <div className="dev-note">Development mode. Live judging requires Atlas, the Voyage memory index, and OpenAI credentials.</div>}
      </section>

      <section className="version-track" aria-label="Harness versions">
        {[['v0','TRUST RESPONSE'],['v1','VERIFY OUTCOME'],['v2','MEMORY'],['v3','REPLAY + PROMOTE']].map(([version, label], index) => { const evaluation = index === 3 ? latestEval : engineeredEvals.find(item => item.version === version); return <div className={`version-step ${index === 3 && promoted ? 'active' : index <= 2 ? 'built' : ''}`} key={version}><span>{version}</span><strong>{label}</strong><small>{evaluation ? `${evaluation.results.filter(item => item.passed).length}/18 PASS · ${evaluation.results.filter(item => item.falseSuccess).length} FALSE CLAIMS` : '— /18'}</small></div>; })}
      </section>
      <div className="metric-note">PROMOTION METRIC <strong>18/18 REPLAY CASES</strong> + ZERO FALSE-SUCCESS CLAIMS + ZERO DUPLICATE CHARGES. <span>v1/v2 are engineered; v3 is model-proposed and replay-gated.</span></div>

      <section className="live-flow" aria-label="Live working flow">
        <div className="live-flow-head"><div><span className="flow-kicker">LIVE SYSTEM FLOW</span><h2>Follow the evidence, not an animation.</h2></div><span className="flow-source">{runId ? `ATLAS RUN ${runId.slice(0, 8).toUpperCase()}` : 'WAITING FOR A RUN'}</span></div>
        <FlowLane label="01 / DETECT THE FALSE SUCCESS" steps={flowSteps.slice(0, 4)} />
        <FlowLane label="02 / EVOLVE AND VERIFY" steps={flowSteps.slice(4)} />
        <div className="flow-monitor" aria-live="polite"><span>RAINDROP MONITORING ↗</span><strong>{!ready?.raindropConfigured ? 'NOT CONFIGURED' : raindropError ? 'TELEMETRY ERROR' : `${raindropEvents.length}/2 OUTCOMES RECORDED`}</strong><small>Observes v0 and v3 traces. It does not control policy promotion.</small></div>
      </section>

      <section className="stage-grid">
        <article className="panel agent-panel">
          <div className="panel-heading"><span className="panel-index">01</span><span>TASK AGENT</span><span className="panel-marker">{baselineClaimed ? '●' : '○'}</span></div>
          <div className="panel-intro">“Upgrade Maya to Pro.”</div>
          <div className="timeline" aria-live="polite">
            {events.filter(event => ['baseline','improved'].includes(event.phase) && ['tool','claim','version','verified-success','escalated'].includes(event.kind)).map(event => <div className={`timeline-row ${event.phase}`} key={event.seq}><span className="time">{String(event.seq).padStart(2,'0')}</span><span className="phase-tag">{event.phase === 'baseline' ? 'v0' : 'v3'}</span><span>{event.message}</span></div>)}
            {!events.length && <div className="empty">Waiting for the first action…</div>}
          </div>
        </article>

        <article className={`panel customer-panel ${falseSuccess && !verified ? 'failure' : ''} ${verified ? 'success' : ''}`}>
          <div className="panel-heading"><span className="panel-index">02</span><span>GROUND TRUTH</span><span className="panel-marker">◇</span></div>
          <div className="customer-avatar">M</div>
          <div className="customer-name">Maya Chen</div>
          <div className="customer-email">maya@example.com</div>
          <div className="plan-line"><span>FREE</span><span className="arrow">→</span><span>PRO</span></div>
          <div className="state-row"><span>PAYMENT</span><strong>{events.some(e => e.kind === 'tool' && e.message.includes('charge_customer')) ? '● CONFIRMED' : '○ PENDING'}</strong></div>
          <div className="state-row"><span>ENTITLEMENT</span><strong className={customerAccess ? 'good' : 'bad'}>{customerAccess ? '● ACTIVE' : '○ INACTIVE'}</strong></div>
          <div className={`access-banner ${customerAccess ? 'unlocked' : ''}`}>{customerAccess ? '◈  PRO ACCESS UNLOCKED' : '⌑  ACCESS LOCKED'}</div>
          <div className="customer-foot">INDEPENDENT {ready?.storage === 'atlas' ? 'ATLAS' : 'LOCAL'} STATE READ</div>
        </article>

        <article className="panel shapi-panel">
          <div className="panel-heading"><span className="panel-index">03</span><span>SHAPI VERIFIER</span><span className="panel-marker">✳</span></div>
          <div className="contract-label">OUTCOME CONTRACT</div>
          <div className="contract">payment_succeeded <span>→</span><br />entitlement_active</div>
          <div className={`verdict ${verified ? 'positive' : falseSuccess ? 'negative' : ''}`}>{verified ? 'VERIFIED SUCCESS' : falseSuccess ? 'FALSE SUCCESS' : 'AWAITING VERIFICATION'}</div>
          <div className="verdict-copy">{verified ? 'The customer really has Pro access.' : falseSuccess ? 'The model said complete. Customer state disagrees.' : 'SHAPI will inspect the actual customer record.'}</div>
          {ready?.raindropConfigured && <div className="raindrop-status">RAINDROP · {raindropError ? 'TELEMETRY ERROR' : `${raindropEvents.length}/2 OUTCOMES RECORDED`}</div>}
        </article>
      </section>

      <section className="learning-grid">
        <article className="panel memory-panel"><div className="panel-heading"><span className="panel-index">04</span><span>{ready?.storage === 'atlas' ? 'ATLAS MEMORY' : 'LOCAL MEMORY'}</span><span className="panel-marker">◌</span></div><div className="subheading">RETRIEVED EPISODES</div>{memories.length ? memories.map((memory, i) => <div className="memory-card" key={memory.id}><span className="memory-number">0{i+1}</span><p>{memory.summary}</p><span className="score">{memory.score == null ? '—' : `${Math.round(memory.score * 100)}%`} MATCH</span></div>) : <div className="empty">Similar incidents appear here after the first failure.</div>}</article>
        <article className="panel repair-panel"><div className="panel-heading"><span className="panel-index">05</span><span>POLICY PROPOSER</span><span className="panel-marker">⌘</span></div><div className="subheading">CANDIDATE GUARDRAIL</div>{events.filter(e => e.kind === 'candidate').at(-1) ? <div className="policy-card"><span>+ NEW RULE</span><p>{String((events.filter(e => e.kind === 'candidate').at(-1)?.data?.candidate as { explanation?: string })?.explanation ?? '')}</p><div>VERIFY → RECONCILE ONCE → VERIFY → ESCALATE</div></div> : <div className="empty">The proposer waits for a verified incident and Atlas memory.</div>}<div className="policy-status">{promoted ? '● POLICY PROMOTED TO v3' : events.some(e => e.kind === 'rejected') ? '● CANDIDATE REJECTED · REVISING' : '○ AWAITING REPLAY'}</div></article>
      </section>

      <section className="panel replay-panel"><div className="panel-heading"><span className="panel-index">06</span><span>REPLAY GATE</span><span className="panel-marker">↻</span></div><div className="replay-body"><div><div className="replay-count">{latestEval ? latestEval.results.filter(item => item.passed).length : '—'}<span>/18</span></div><p>Distinct outcome scenarios.<br />Every tile is a measured result.</p></div><div className="tiles">{Array.from({length:18}, (_,i) => { const item = latestEval?.results[i]; return <div className={`tile ${item ? item.passed ? 'pass' : 'fail' : ''}`} title={item?.detail ?? `Case ${i+1} pending`} key={i}>{item ? item.passed ? '✓' : '×' : '·'}</div>; })}</div><div className="replay-status">{promoted ? 'PROMOTION APPROVED' : latestEval ? latestEval.passed ? 'ALL CHECKS PASSED' : 'REGRESSION FOUND' : 'WAITING FOR CANDIDATE'}</div></div></section>

      <footer><span>SHAPI / AGENTS ACT. REALITY DECIDES.</span><button onClick={() => setShowEvidence(true)} disabled={!runId}>INSPECT {ready?.storage === 'atlas' ? 'ATLAS' : 'LOCAL'} EVIDENCE ↗</button><span>{runId ? `RUN ${runId.slice(0,8).toUpperCase()}` : 'NO RUN YET'}</span></footer>
    </main>

    {showEvidence && <div className="modal-backdrop" onClick={() => setShowEvidence(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Run evidence" onClick={event => event.stopPropagation()}><div className="modal-head"><h2>Run evidence</h2><button onClick={() => setShowEvidence(false)}>CLOSE ×</button></div><p>Stored records from {ready?.storage === 'atlas' ? 'MongoDB Atlas' : 'the local development store'}.</p><pre>{JSON.stringify(evidence ?? { message: 'Run still in progress', events }, null, 2)}</pre></div></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
