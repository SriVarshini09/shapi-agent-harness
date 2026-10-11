export type EvolutionEvent = { phase: string; kind: string; data?: Record<string, unknown> };
export type VersionId = 'v0' | 'v1' | 'v2' | 'v3';
export type EvolutionStage = 'waiting' | 'running' | 'complete';
export type EvolutionStep = {
  version: VersionId;
  origin: string;
  change: string;
  capability: string;
  stage: EvolutionStage;
  result: string;
  claim: string;
  access: string;
  replay: string;
  memoryHits: number | null;
  toolNames: string[];
};

const steps: Pick<EvolutionStep, 'version' | 'origin' | 'change' | 'capability'>[] = [
  { version: 'v0', origin: 'ENGINEERED BASELINE', change: 'Trust the upgrade response', capability: 'No independent access check' },
  { version: 'v1', origin: 'ENGINEERED GUARDRAIL', change: 'Verify the real outcome', capability: '+ verify_entitlement' },
  { version: 'v2', origin: 'ENGINEERED MEMORY', change: 'Retrieve prior incidents', capability: '+ Atlas episode retrieval' },
  { version: 'v3', origin: 'MODEL-PROPOSED POLICY', change: 'Await a policy candidate', capability: 'Replay gate decides allowed tools' },
];

export function deriveEvolution(events: EvolutionEvent[]): EvolutionStep[] {
  const outcomeFor = (version: VersionId) => events.find(event => event.kind === 'version-outcome' && event.data?.version === version)?.data;
  const replayFor = (version: VersionId) => events.filter(event => {
    if (event.kind !== 'version-result' && event.kind !== 'results') return false;
    return (event.data?.evaluation as { version?: string } | undefined)?.version === version;
  }).at(-1)?.data?.evaluation as { results?: { passed: boolean }[] } | undefined;

  return steps.map(step => {
    const outcome = outcomeFor(step.version);
    const started = events.some(event => event.kind === 'version' && event.data?.version === step.version);
    const proposing = step.version === 'v3' && (Boolean(outcomeFor('v2')) || events.some(event => ['candidate', 'results', 'promoted'].includes(event.kind)));
    const candidate = step.version === 'v3' ? events.filter(event => event.kind === 'candidate').at(-1)?.data?.candidate as { maxReconcileAttempts?: number } | undefined : undefined;
    const stage: EvolutionStage = outcome ? 'complete' : started || proposing ? 'running' : 'waiting';
    const claim = outcome?.claim === 'success' ? 'SUCCESS CLAIM' : outcome?.claim === 'escalate' ? 'ESCALATED' : '—';
    const access = outcome ? outcome.entitlementActive === true ? 'PRO ACTIVE' : 'PRO LOCKED' : '—';
    const result = outcome
      ? outcome.verified === true ? 'VERIFIED RECOVERY' : outcome.claim === 'success' ? 'FALSE SUCCESS' : 'SAFE ESCALATION'
      : stage === 'running' ? step.version === 'v3' && !started ? 'PROPOSING + REPLAYING' : 'AGENT RUNNING' : 'WAITING';
    const replay = replayFor(step.version);
    return {
      ...step,
      change: candidate ? candidate.maxReconcileAttempts === 1 ? 'Recover once, then reverify' : 'Verify and escalate candidate' : step.change,
      capability: candidate ? candidate.maxReconcileAttempts === 1 ? '+ one bounded reconciliation' : '+ no reconciliation allowed' : step.capability,
      stage, result, claim, access,
      replay: replay?.results ? `${replay.results.filter(item => item.passed).length}/${replay.results.length}` : '—',
      memoryHits: outcome && typeof outcome.memoryCount === 'number' ? outcome.memoryCount : null,
      toolNames: outcome && Array.isArray(outcome.toolNames) ? outcome.toolNames.filter((name): name is string => typeof name === 'string') : [],
    };
  });
}

export function deriveFaultEvidence(events: EvolutionEvent[], armed: boolean) {
  const baselineTool = (name: string) => events.find(event => event.phase === 'baseline' && event.kind === 'tool' && event.data?.tool === name);
  const payment = baselineTool('charge_customer')?.data?.result as { provider?: string; paymentId?: string } | undefined;
  const upgrade = baselineTool('upgrade_customer')?.data?.result as { status?: number } | undefined;
  const mismatch = events.find(event => event.kind === 'false-success');
  const recovered = events.some(event => event.kind === 'verified-success');
  return {
    armed,
    payment: payment ? payment.provider === 'stripe-test' ? 'STRIPE TEST PAYMENT SUCCEEDED' : 'SIMULATED PAYMENT SUCCEEDED' : 'NOT CALLED YET',
    paymentId: payment?.paymentId ?? null,
    upgrade: upgrade ? `RETURNED ${upgrade.status ?? 'RESPONSE'}` : armed ? 'WILL RETURN 200 OK' : 'NOT CALLED YET',
    entitlement: mismatch ? 'INACTIVE AFTER 200 OK' : armed ? 'WRITE WILL BE SKIPPED' : 'NORMAL PATH',
    mismatch: Boolean(mismatch),
    recovered,
  };
}
