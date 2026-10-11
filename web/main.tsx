import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { deriveLiveFlow, type FlowStep } from './flow-state';
import { deriveEvolution, deriveFaultEvidence, type EvolutionStep } from './evolution-state';
import './style.css';

type Event = { seq: number; at: string; phase: string; kind: string; message: string; data?: Record<string, unknown> };
type Ready = { database: boolean; memoryIndex: boolean; storage: string; agents: string; model: string; liveReady: boolean; raindropConfigured: boolean; paymentProvider: 'simulated' | 'stripe-test' };
type Session = { id: string; fault: string; customerId: string };
type Case = { id: string; passed: boolean; falseSuccess: boolean; category: string; detail: string };
type Evaluation = { id: string; version: string; passed: boolean; results: Case[] };
type VersionOutcome = { version: string; claim: 'success' | 'escalate'; verified: boolean; paymentSucceeded: boolean; entitlementActive: boolean; paymentReused: boolean; toolNames: string[]; memoryCount: number; model: string };
type Episode = { id: string; summary: string; score?: number; source: string };
type Evidence = { run: { status: string; baselineClaim?: string; baselineVerified?: boolean; improvedClaim?: string; improvedVerified?: boolean }; customer: { name: string; entitlementActive: boolean }; payment: { id: string; provider?: string } | null; episodes: Episode[]; policies: { id: string; version: string; status: string; explanation: string }[]; evals: Evaluation[]; activeVersion: string };

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body as T;
}

function FlowLane({ label, steps }: { label: string; steps: FlowStep[] }) {
  return <div className="flow-lane"><div className="flow-lane-label">{label}</div><div className="flow-nodes">{steps.map((step, index) => <div className={`flow-node ${step.status}`} key={step.id}><div className="flow-node-top"><span>{step.system}</span><span className="flow-node-state">{step.status === 'issue' ? 'ISSUE' : step.status === 'done' ? 'DONE' : step.status === 'running' ? 'LIVE' : 'WAITING'}</span></div><strong>{step.action}</strong><small>{step.detail}</small>{index < steps.length - 1 && <span className="flow-arrow" aria-hidden="true">→</span>}</div>)}</div></div>;
}

function ComparisonCard({ version, label, evaluation, outcome, running }: { version: string; label: string; evaluation?: Evaluation; outcome?: VersionOutcome; running: boolean }) {
  const result = outcome ? outcome.verified ? 'VERIFIED ACCESS' : outcome.claim === 'success' ? 'FALSE SUCCESS' : 'SAFE ESCALATION' : running ? 'AGENT RUNNING…' : 'WAITING';
  return <article className={`compare-card ${outcome ? outcome.verified ? 'verified' : outcome.claim === 'success' ? 'false' : 'safe' : running ? 'running' : ''}`}>
    <div className="compare-top"><span>{version}</span><strong>{label}</strong></div>
    <div className="compare-result" aria-live="polite">{result}</div>
    <div className="compare-facts"><span>REPLAY <b>{evaluation ? `${evaluation.results.filter(item => item.passed).length}/18` : '—/18'}</b></span><span>ACCESS <b>{outcome ? outcome.entitlementActive ? 'ACTIVE' : 'LOCKED' : '—'}</b></span><span>PAYMENT <b>{outcome ? outcome.paymentReused ? 'REUSED' : 'FIRST CHARGE' : '—'}</b></span><span>MEMORY <b>{outcome ? outcome.memoryCount : '—'} HITS</b></span></div>
    <div className="compare-tools">{outcome ? outcome.toolNames.join(' → ') : running ? 'Live tool calls appearing below…' : 'Awaiting live agent run'}</div>
  </article>;
}

function EvolutionCard({ step }: { step: EvolutionStep }) {
  return <article className={`evolution-card ${step.stage} ${step.result === 'FALSE SUCCESS' ? 'false' : ''} ${step.result === 'VERIFIED RECOVERY' ? 'verified' : ''}`}>
    <div className="evolution-card-top"><strong>{step.version}</strong><span>{step.origin}</span><em>{step.stage === 'complete' ? 'OBSERVED' : step.stage === 'running' ? 'RUNNING' : 'WAITING'}</em></div>
    <h3>{step.change}</h3>
    <div className="evolution-capability">{step.capability}</div>
    <div className="evolution-result" aria-live="polite">{step.result}</div>
    <div className="evolution-measures"><span>AGENT CLAIM <b>{step.claim}</b></span><span>CUSTOMER <b>{step.access}</b></span><span>REPLAY <b>{step.replay}</b></span></div>
    {step.memoryHits !== null && step.version !== 'v0' && <div className="evolution-foot">{step.memoryHits} PRIOR MEMORY HITS · {step.toolNames.length} TOOL CALLS</div>}
  </article>;
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
  const engineeredEvals = events.filter(item => item.kind === 'version-result').map(item => item.data?.evaluation as Evaluation);
  const versionOutcomes = events.filter(item => item.kind === 'version-outcome').map(item => item.data as VersionOutcome);
  const falseSuccess = events.some(event => event.kind === 'false-success');
  const verified = events.some(event => event.kind === 'verified-success');
  const promoted = events.some(event => event.kind === 'promoted');
  const raindropEvents = events.filter(event => event.kind === 'raindrop-recorded');
  const raindropError = events.some(event => event.kind === 'raindrop-error');
  const baselineClaimed = events.some(event => event.phase === 'baseline' && event.kind === 'claim');
  const latestEntitlementRead = events.filter(event => event.kind === 'tool' && event.data?.tool === 'verify_entitlement').at(-1)?.data?.result as { entitlementActive?: boolean } | undefined;
  const customerAccess = evidence?.customer.entitlementActive ?? latestEntitlementRead?.entitlementActive ?? verified;
  const runFinished = events.some(event => ['verified-success', 'escalated', 'error'].includes(event.kind));
  const liveMode = ready?.liveReady === true;
  const flowSteps = useMemo(() => deriveLiveFlow(events, session?.fault === 'silent', liveMode), [events, session?.fault, liveMode]);
  const evolution = useMemo(() => deriveEvolution(events), [events]);
  const faultEvidence = useMemo(() => deriveFaultEvidence(events, session?.fault === 'silent'), [events, session?.fault]);
  const latestCandidate = events.filter(event => event.kind === 'candidate').at(-1)?.data?.candidate as { explanation?: string; maxReconcileAttempts?: number } | undefined;
  const runningVersion = evolution.find(step => step.stage === 'running')?.version;

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
      document.getElementById('harness-evolution')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
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
      <div className="status-group"><span className={`status-dot ${ready?.liveReady ? 'live' : ''}`} />{ready?.liveReady ? `LIVE ATLAS + MODEL / ${ready.paymentProvider === 'stripe-test' ? 'STRIPE TEST' : 'SIM PAYMENT'}` : ready ? `${ready.storage.toUpperCase()} / ${ready.agents.toUpperCase()} / ${ready.paymentProvider === 'stripe-test' ? 'STRIPE TEST' : 'SIM PAYMENT'}` : 'CONNECTING'}<span className="version-pill">{runId && !runFinished ? `RUNNING ${runningVersion ?? 'STARTING'}` : `ACTIVE POLICY ${promoted ? 'v3' : 'v2'}`}</span></div>
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
        {ready?.liveReady && ready.paymentProvider !== 'stripe-test' && <div className="dev-note">Payment is still simulated. Add a Stripe test secret key to enable a real Stripe API call; no money moves in test mode.</div>}
      </section>

      <section className={`fault-lab ${faultEvidence.armed ? 'armed' : ''}`} aria-label="What Break Provider changes">
        <div className="fault-lab-head"><div><span className="flow-kicker">FAULT INJECTION / WHAT WE BREAK</span><h2>{faultEvidence.armed ? 'The upgrade acknowledgment lies.' : 'Arm a silent upgrade failure.'}</h2></div><strong>{faultEvidence.armed ? 'SILENT FAILURE ARMED' : 'NORMAL PROVIDER'}</strong></div>
        <p><strong>Break Provider</strong> targets only the <code>simulated upgrade_customer</code> provider. When armed, it returns <code>200 OK</code> but skips the Pro-entitlement write. {ready?.paymentProvider === 'stripe-test' ? 'Stripe remains a real test-mode API; no money moves.' : 'Payment is simulated in this mode.'}</p>
        <div className="fault-chain"><div><span>01 / PAYMENT</span><strong>{faultEvidence.payment}</strong>{faultEvidence.paymentId && <small>{faultEvidence.paymentId}</small>}</div><span className="fault-arrow">→</span><div><span>02 / UPGRADE API</span><strong>{faultEvidence.upgrade}</strong></div><span className="fault-arrow">{faultEvidence.armed ? '≠' : '→'}</span><div className={faultEvidence.mismatch ? 'fault-mismatch' : ''}><span>03 / {ready?.storage === 'atlas' ? 'ATLAS' : 'LOCAL'} GROUND TRUTH</span><strong>{faultEvidence.entitlement}</strong></div></div>
        {faultEvidence.mismatch && <div className="fault-verdict">OBSERVED MISMATCH: accepted request ≠ customer access. {faultEvidence.recovered ? 'v3 later restored access through a separate, verified reconciliation.' : 'SHAPI now tests a safer policy.'}</div>}
      </section>

      <section className="evolution" id="harness-evolution" aria-label="Live harness evolution">
        <div className="evolution-head"><div><span className="flow-kicker">LIVE HARNESS EVOLUTION / v0 → v3</span><h2>Watch the rule change, not the model weights.</h2></div><span>2 AGENT ROLES · 4 TASK RUNS · SAME {ready?.model ?? 'MODEL'}</span></div>
        <p>v1 and v2 are engineered harness upgrades. The Policy Proposer suggests v3; the 18-case deterministic replay gate must approve it before the Task Agent receives reconciliation permission.</p>
        <div className="evolution-grid">{evolution.map(step => <EvolutionCard key={step.version} step={step} />)}</div>
        <div className="evolution-gate">PROMOTION GATE <strong>18/18 REPLAY CASES</strong> · ZERO FALSE-SUCCESS CLAIMS · ZERO DUPLICATE CHARGES <span>Scores are replay results, not live-run success rates.</span></div>
      </section>

      <section className="comparison" aria-label="Four harness versions compared live">
        <div className="comparison-head"><div><span className="flow-kicker">{liveMode ? 'LIVE FOUR-VERSION COMPARISON' : 'SIMULATED FOUR-VERSION COMPARISON'}</span><h2>Same model. Same fault. Different harness.</h2></div><span>{versionOutcomes.length}/4 AGENT RUNS COMPLETE</span></div>
        <div className="comparison-grid">{[['v0', 'TRUSTS 200 OK'], ['v1', 'VERIFIES OUTCOME'], ['v2', 'VERIFIES + USES MEMORY'], ['v3', 'RECONCILES + REVERIFIES']].map(([version, label]) => <ComparisonCard key={version} version={version} label={label} evaluation={version === 'v3' ? latestEval : engineeredEvals.find(item => item.version === version)} outcome={versionOutcomes.find(item => item.version === version)} running={!runFinished && events.some(item => item.kind === 'version' && item.data?.version === version) && !versionOutcomes.some(item => item.version === version)} />)}</div>
        {runFinished && !versionOutcomes.length && <p className="comparison-note">This stored run predates the four-version live comparison. Click Reset Demo to run all four agents.</p>}
        <p className="comparison-note">{liveMode ? `Live outcome = actual model tool calls + independent Atlas state read. Payment provider = ${ready?.paymentProvider === 'stripe-test' ? 'Stripe test-mode API' : 'simulator'}.` : 'Development outcome = simulated agent tool calls + local state read; not Atlas/OpenAI evidence.'} Replay score = separate deterministic 18-case evaluation. v0 creates one {ready?.paymentProvider === 'stripe-test' ? 'test payment' : 'simulated payment'}; v1–v3 reuse it idempotently.</p>
      </section>

      <section className="live-flow" aria-label="Live working flow">
        <div className="live-flow-head"><div><span className="flow-kicker">{liveMode ? 'LIVE SYSTEM FLOW' : 'SIMULATED SYSTEM FLOW'}</span><h2>Follow the evidence, not an animation.</h2></div><span className="flow-source">{runId ? `${liveMode ? 'ATLAS' : 'LOCAL'} RUN ${runId.slice(0, 8).toUpperCase()}` : 'WAITING FOR A RUN'}</span></div>
        <FlowLane label="01 / DETECT THE FALSE SUCCESS" steps={flowSteps.slice(0, 4)} />
        <FlowLane label="02 / EVOLVE AND VERIFY" steps={flowSteps.slice(4)} />
        <div className="flow-monitor" aria-live="polite"><span>RAINDROP MONITORING ↗</span><strong>{!ready?.raindropConfigured ? 'NOT CONFIGURED' : raindropError ? 'TELEMETRY ERROR' : `${raindropEvents.length}/4 OUTCOMES RECORDED`}</strong><small>Observes all four agent traces. It does not control policy promotion.</small></div>
      </section>

      <section className="stage-grid">
        <article className="panel agent-panel">
          <div className="panel-heading"><span className="panel-index">01</span><span>TASK AGENT</span><span className="panel-marker">{baselineClaimed ? '●' : '○'}</span></div>
          <div className="panel-intro">“Upgrade Maya to Pro.”</div>
          <div className="timeline" aria-live="polite">
            {events.filter(event => ['baseline','v1','v2','improved'].includes(event.phase) && ['tool','claim','version','verified-success','escalated'].includes(event.kind)).map(event => <div className={`timeline-row ${event.phase}`} key={event.seq}><span className="time">{String(event.seq).padStart(2,'0')}</span><span className="phase-tag">{event.phase === 'baseline' ? 'v0' : event.phase === 'improved' ? 'v3' : event.phase}</span><span>{event.message}</span></div>)}
            {!events.length && <div className="empty">Waiting for the first action…</div>}
          </div>
        </article>

        <article className={`panel customer-panel ${falseSuccess && !verified ? 'failure' : ''} ${verified ? 'success' : ''}`}>
          <div className="panel-heading"><span className="panel-index">02</span><span>GROUND TRUTH</span><span className="panel-marker">◇</span></div>
          <div className="customer-avatar">M</div>
          <div className="customer-name">Maya Chen</div>
          <div className="customer-email">maya@example.com</div>
          <div className="plan-line"><span>FREE</span><span className="arrow">→</span><span>PRO</span></div>
          <div className="state-row"><span>{ready?.paymentProvider === 'stripe-test' ? 'STRIPE TEST PAYMENT' : 'SIMULATED PAYMENT'}</span><strong>{events.some(e => e.kind === 'tool' && e.data?.tool === 'charge_customer') ? '● CONFIRMED' : '○ PENDING'}</strong></div>
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
          {ready?.raindropConfigured && <div className="raindrop-status">RAINDROP · {raindropError ? 'TELEMETRY ERROR' : `${raindropEvents.length}/4 OUTCOMES RECORDED`}</div>}
        </article>
      </section>

      <section className="learning-grid">
        <article className="panel memory-panel"><div className="panel-heading"><span className="panel-index">04</span><span>{ready?.storage === 'atlas' ? 'ATLAS MEMORY' : 'LOCAL MEMORY'}</span><span className="panel-marker">◌</span></div><div className="subheading">RETRIEVED EPISODES</div>{memories.length ? memories.map((memory, i) => <div className="memory-card" key={memory.id}><span className="memory-number">0{i+1}</span><p>{memory.summary}</p><span className="score">{memory.score == null ? '—' : `${Math.round(memory.score * 100)}%`} MATCH</span></div>) : <div className="empty">Similar incidents appear here after the first failure.</div>}</article>
        <article className="panel repair-panel"><div className="panel-heading"><span className="panel-index">05</span><span>POLICY PROPOSER</span><span className="panel-marker">⌘</span></div><div className="subheading">CANDIDATE GUARDRAIL</div>{latestCandidate ? <div className="policy-card"><span>+ NEW RULE</span><p>{latestCandidate.explanation ?? ''}</p><div>{latestCandidate.maxReconcileAttempts === 1 ? 'VERIFY → RECONCILE ONCE → VERIFY → ESCALATE IF NEEDED' : 'VERIFY → ESCALATE IF ACCESS IS INACTIVE'}</div></div> : <div className="empty">The proposer waits for a verified incident and {liveMode ? 'Atlas' : 'local'} memory.</div>}<div className="policy-status">{promoted ? '● POLICY PROMOTED TO v3' : events.some(e => e.kind === 'rejected') ? '● CANDIDATE REJECTED · REVISING' : '○ AWAITING REPLAY'}</div></article>
      </section>

      <section className="panel replay-panel"><div className="panel-heading"><span className="panel-index">06</span><span>REPLAY GATE</span><span className="panel-marker">↻</span></div><div className="replay-body"><div><div className="replay-count">{latestEval ? latestEval.results.filter(item => item.passed).length : '—'}<span>/18</span></div><p>Distinct outcome scenarios.<br />Every tile is a measured result.</p></div><div className="tiles">{Array.from({length:18}, (_,i) => { const item = latestEval?.results[i]; return <div className={`tile ${item ? item.passed ? 'pass' : 'fail' : ''}`} title={item?.detail ?? `Case ${i+1} pending`} key={i}>{item ? item.passed ? '✓' : '×' : '·'}</div>; })}</div><div className="replay-status">{promoted ? 'PROMOTION APPROVED' : latestEval ? latestEval.passed ? 'ALL CHECKS PASSED' : 'REGRESSION FOUND' : 'WAITING FOR CANDIDATE'}</div></div></section>

      <footer><span>SHAPI / AGENTS ACT. REALITY DECIDES.</span><button onClick={() => setShowEvidence(true)} disabled={!runId}>INSPECT {ready?.storage === 'atlas' ? 'ATLAS' : 'LOCAL'} EVIDENCE ↗</button><span>{runId ? `RUN ${runId.slice(0,8).toUpperCase()}` : 'NO RUN YET'}</span></footer>
    </main>

    {showEvidence && <div className="modal-backdrop" onClick={() => setShowEvidence(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="Run evidence" onClick={event => event.stopPropagation()}><div className="modal-head"><h2>Run evidence</h2><button onClick={() => setShowEvidence(false)}>CLOSE ×</button></div><p>Stored records from {ready?.storage === 'atlas' ? 'MongoDB Atlas' : 'the local development store'}.</p><pre>{JSON.stringify(evidence ?? { message: 'Run still in progress', events }, null, 2)}</pre></div></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
