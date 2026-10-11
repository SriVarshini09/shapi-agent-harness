export type FlowEvent = { seq: number; phase: string; kind: string; data?: Record<string, unknown> };
export type FlowStatus = 'waiting' | 'running' | 'done' | 'issue';
export type FlowStep = { id: string; system: string; action: string; detail: string; status: FlowStatus };

export function deriveLiveFlow(events: FlowEvent[], providerBroken: boolean, liveMode = true): FlowStep[] {
  const has = (kind: string) => events.some(event => event.kind === kind);
  const tool = (phase: string, name: string) => events.find(event => event.phase === phase && event.kind === 'tool' && event.data?.tool === name);
  const baselineClaim = events.find(event => event.phase === 'baseline' && event.kind === 'claim');
  const memory = events.find(event => event.kind === 'retrieved');
  const candidates = events.filter(event => event.kind === 'candidate');
  const evaluation = events.filter(event => event.kind === 'results').at(-1)?.data?.evaluation as { results?: { passed: boolean }[] } | undefined;
  const upgraded = tool('baseline', 'upgrade_customer');
  const recovered = tool('improved', 'reconcile_entitlement');
  const verified = has('verified-success');
  const escalated = has('escalated');
  const falseSuccess = has('false-success');
  const failed = has('error');
  const memoryCount = Array.isArray(memory?.data?.memories) ? memory.data.memories.length : 0;
  const passedCount = evaluation?.results?.filter(result => result.passed).length;

  return [
    { id: 'agent', system: liveMode ? 'OPENAI TASK AGENT' : 'SIMULATED TASK AGENT', action: 'Run v0', detail: baselineClaim ? `Claim: ${String(baselineClaim.data?.claim ?? 'unknown')}` : events.length ? 'Calling tools…' : 'Awaiting upgrade request', status: baselineClaim ? 'done' : events.length ? 'running' : 'waiting' },
    { id: 'provider', system: 'SIMULATED PROVIDER', action: 'Upgrade API', detail: upgraded ? `Returned ${String((upgraded.data?.result as { status?: number })?.status ?? 'response')}` : providerBroken ? 'Silent failure armed' : 'Awaiting fault injection', status: upgraded ? 'done' : providerBroken ? 'running' : 'waiting' },
    { id: 'truth', system: liveMode ? 'MONGODB ATLAS' : 'LOCAL MEMORY STORE', action: 'Read customer truth', detail: falseSuccess ? 'Paid; Pro access inactive' : has('baseline-not-reproduced') ? 'Outcome read completed' : 'Awaiting independent read', status: falseSuccess ? 'issue' : has('baseline-not-reproduced') ? 'done' : baselineClaim ? 'running' : 'waiting' },
    { id: 'verifier', system: 'SHAPI VERIFIER', action: 'Compare claim vs reality', detail: falseSuccess ? 'False success detected' : has('baseline-not-reproduced') ? 'No mismatch detected' : 'Awaiting outcome', status: falseSuccess ? 'issue' : has('baseline-not-reproduced') ? 'done' : baselineClaim ? 'running' : 'waiting' },
    { id: 'memory', system: liveMode ? 'ATLAS + VOYAGE-4' : 'LOCAL EPISODE MEMORY', action: 'Retrieve memory', detail: memory ? `${memoryCount} prior episodes retrieved` : 'Awaiting verified incident', status: memory ? 'done' : falseSuccess && !failed ? 'running' : 'waiting' },
    { id: 'proposer', system: liveMode ? 'OPENAI POLICY PROPOSER' : 'SIMULATED PROPOSER', action: 'Suggest a policy', detail: candidates.length ? `Candidate ${candidates.length} stored` : 'Awaiting incident memory', status: candidates.length ? 'done' : memory && !failed ? 'running' : 'waiting' },
    { id: 'replay', system: 'SHAPI REPLAY GATE', action: 'Test 18 cases', detail: has('promoted') ? `${passedCount ?? 0}/18 passed; v3 promoted` : evaluation ? `${passedCount ?? 0}/18 passed; revising` : 'Awaiting candidate', status: has('promoted') ? 'done' : evaluation ? 'issue' : candidates.length ? 'running' : 'waiting' },
    { id: 'recovery', system: liveMode ? 'OPENAI TASK AGENT' : 'SIMULATED TASK AGENT', action: 'Retry with v3', detail: verified ? 'Pro access independently verified' : escalated ? 'Escalated; no false success' : recovered ? 'Reconciled; verifying…' : has('promoted') ? 'Running v3 tools…' : 'Awaiting promotion', status: verified ? 'done' : escalated ? 'issue' : has('promoted') && !failed ? 'running' : 'waiting' },
  ];
}
