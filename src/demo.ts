import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Agents } from './agents.js';
import { candidatePolicy, ensurePolicies, policyForVersion } from './policies.js';
import { evaluatePolicy } from './evals.js';
import { makeTools, verifyReality } from './simulator.js';
import type { DemoRun, DemoSession, Episode, Evidence, RunEvent, Store } from './types.js';

export class DemoCoordinator {
  private emitters = new Map<string, EventEmitter>();
  private runningSessions = new Set<string>();
  constructor(private store: Store, private agents: Agents) {}

  async start(sessionId: string): Promise<string> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (this.runningSessions.has(sessionId)) throw new Error('A demo is already running in this session');
    if (session.fault !== 'silent') throw new Error('Click Break Provider before running the demo');
    const ready = await this.store.readiness();
    if (!ready.database || !ready.memoryIndex) throw new Error('Atlas database or memory index is not ready');
    const id = randomUUID();
    const run: DemoRun = { id, sessionId, model: this.agents.model, status: 'running', events: [], createdAt: new Date().toISOString() };
    await this.store.createRun(run);
    this.emitters.set(id, new EventEmitter());
    this.runningSessions.add(sessionId);
    void this.execute(id, session).finally(() => { this.runningSessions.delete(sessionId); });
    return id;
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const emitter = this.emitters.get(runId);
    if (!emitter) return () => undefined;
    emitter.on('event', listener);
    return () => emitter.off('event', listener);
  }

  async evidence(runId: string): Promise<Evidence> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error('Run not found');
    const session = await this.store.getSession(run.sessionId);
    if (!session) throw new Error('Session not found');
    const [customer, payment, episodes, policies, evals, activeVersion] = await Promise.all([
      this.store.getCustomer(session.customerId), this.store.getPayment(session.id),
      this.store.listEpisodes(runId), this.store.listPolicies(), this.store.listEvals(runId),
      this.store.getActiveVersion(session.id),
    ]);
    return { run, customer, payment, episodes, policies, evals, activeVersion };
  }

  private async event(runId: string, phase: RunEvent['phase'], kind: string, message: string, data?: Record<string, unknown>): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error('Run not found');
    const event: RunEvent = { seq: run.events.length + 1, at: new Date().toISOString(), phase, kind, message, data: data ? structuredClone(data) : undefined };
    await this.store.appendEvent(runId, event);
    this.emitters.get(runId)?.emit('event', event);
  }

  private async execute(runId: string, session: DemoSession): Promise<void> {
    try {
      await ensurePolicies(this.store);
      const policies = await this.store.listPolicies();
      const baselinePolicy = policyForVersion(policies, 'v0');
      await this.event(runId, 'setup', 'start', 'Same customer request. Same model. Broken provider enabled.', { model: this.agents.model, storage: this.store.mode });
      await this.event(runId, 'baseline', 'version', 'Harness v0 trusts tool responses.', { version: 'v0' });
      const baseline = await this.agents.runTask(baselinePolicy, makeTools(this.store, session), async (tool, result) => {
        await this.event(runId, 'baseline', 'tool', `${tool} → ${JSON.stringify(result)}`, { tool, result });
      });
      await this.event(runId, 'baseline', 'claim', `Task Agent: ${baseline.message}`, { claim: baseline.claim, model: baseline.model, prompt: baseline.prompt });
      const observed = await verifyReality(this.store, session);
      const baselineVerified = baseline.claim === 'success' && observed.outcomeSucceeded;
      await this.store.finishRun(runId, { baselineClaim: baseline.claim, baselineVerified });
      const reproduced = baseline.claim === 'success' && observed.paymentSucceeded && !observed.customer.entitlementActive;
      await this.event(runId, 'verify', reproduced ? 'false-success' : 'baseline-not-reproduced', reproduced ? 'FALSE SUCCESS: payment succeeded, but Maya has no Pro entitlement.' : 'Baseline did not reproduce a false-success claim.', { claim: baseline.claim, paymentSucceeded: observed.paymentSucceeded, entitlementActive: observed.customer.entitlementActive });
      if (!reproduced) throw new Error('Fault injection or baseline claim did not reproduce false success; reset and retry');
      const incidentSummary = 'Upgrade API returned 200 OK after payment, but customer entitlement stayed inactive. Agent claimed success. Reconciliation after payment can grant access.';
      const episode: Episode = {
        id: randomUUID(), sessionId: session.id, runId, source: 'live', version: 'v0', summary: incidentSummary,
        claim: baseline.claim, paymentSucceeded: observed.paymentSucceeded, entitlementActive: observed.customer.entitlementActive,
        createdAt: new Date().toISOString(),
      };
      await this.store.saveEpisode(episode);
      const engineeredEvals = (['v0', 'v1', 'v2'] as const).map(version => evaluatePolicy(policyForVersion(policies, version), runId));
      for (const evaluation of engineeredEvals) await this.store.saveEval(evaluation);
      await this.event(runId, 'eval', 'version-results', 'Measured replay results for engineered harness versions.', { evaluations: engineeredEvals });
      const memories = (await this.store.searchEpisodes(incidentSummary, 4)).filter(memory => memory.id !== episode.id).slice(0, 3);
      if (!memories.length) throw new Error('No prior episodes retrieved from Atlas memory; run setup:atlas and wait for the index');
      await this.event(runId, 'memory', 'retrieved', `${memories.length} prior episodes retrieved from ${this.store.mode === 'atlas' ? 'Atlas Vector Search' : 'simulated memory'}.`, { memories: memories.map(({ id, summary, score, source }) => ({ id, summary, score, source })) });
      let promoted = false;
      let promotedPolicy = null as ReturnType<typeof candidatePolicy> | null;
      let counterexamples: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        let proposed;
        try { proposed = await this.agents.propose(incidentSummary, memories, counterexamples); }
        catch (error) {
          counterexamples = [`Proposal rejected: ${error instanceof Error ? error.message : String(error)}`];
          await this.event(runId, 'propose', 'invalid-proposal', 'Malformed or unsupported proposal rejected.', { counterexamples });
          continue;
        }
        const candidate = candidatePolicy(proposed.proposal, runId, proposed.model, proposed.prompt);
        await this.store.savePolicy(candidate);
        await this.event(runId, 'propose', 'candidate', `Policy Proposer candidate ${attempt}: ${candidate.explanation}`, { candidate, attempt });
        const evaluation = evaluatePolicy(candidate, runId);
        await this.store.saveEval(evaluation);
        await this.event(runId, 'eval', 'results', `Replay ${evaluation.results.filter(result => result.passed).length}/18 passed.`, { evaluation });
        if (!evaluation.passed) {
          await this.store.updatePolicy(candidate.id, 'rejected');
          counterexamples = evaluation.results.filter(result => !result.passed).map(result => `${result.id}: ${result.detail}`);
          await this.event(runId, 'eval', 'rejected', 'Candidate rejected; counterexamples returned to the proposer.', { counterexamples });
          continue;
        }
        const didPromote = await this.store.promotePolicy(session.id, 'v2', candidate.id);
        if (!didPromote) throw new Error('Policy promotion lost its version check');
        await this.store.updatePolicy(candidate.id, 'promoted');
        promoted = true; promotedPolicy = candidate;
        await this.event(runId, 'promote', 'promoted', 'Harness v3 promoted after 18/18 replay cases.', { policyId: candidate.id, version: 'v3', evalId: evaluation.id });
        break;
      }
      if (!promoted || !promotedPolicy) throw new Error('No policy passed the promotion gate');
      await this.event(runId, 'improved', 'version', 'Running the same upgrade with harness v3.', { version: 'v3' });
      const improved = await this.agents.runTask(promotedPolicy, makeTools(this.store, session), async (tool, result) => {
        await this.event(runId, 'improved', 'tool', `${tool} → ${JSON.stringify(result)}`, { tool, result });
      });
      const finalReality = await verifyReality(this.store, session);
      const improvedVerified = improved.claim === 'success' && finalReality.outcomeSucceeded && improved.toolNames.includes('verify_entitlement');
      await this.store.finishRun(runId, { improvedClaim: improved.claim, improvedVerified, status: 'completed', completedAt: new Date().toISOString() });
      await this.event(runId, 'improved', improvedVerified ? 'verified-success' : 'escalated', improvedVerified ? 'VERIFIED SUCCESS: Maya has Pro access.' : 'Upgrade was not verified; escalated.', { claim: improved.claim, entitlementActive: finalReality.customer.entitlementActive, paymentSucceeded: finalReality.paymentSucceeded, prompt: improved.prompt, model: improved.model });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishRun(runId, { status: 'failed', error: message, completedAt: new Date().toISOString() });
      await this.event(runId, 'system', 'error', message);
    }
  }
}
