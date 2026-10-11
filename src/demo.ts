import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Agents } from './agents.js';
import { candidatePolicy, ensurePolicies, policyForVersion } from './policies.js';
import { evaluatePolicy } from './evals.js';
import { makeTools, verifyReality } from './simulator.js';
import { SimulatedPaymentProvider, type PaymentProvider } from './payment-provider.js';
import type { ObservedTool, OutcomeObserver } from './raindrop.js';
import type { DemoRun, DemoSession, Episode, Evidence, Policy, RunEvent, Store, Version } from './types.js';

function policySnapshot(policy: Policy) {
  return {
    version: policy.version, parentVersion: policy.parentVersion,
    requireVerification: policy.requireVerification, useMemory: policy.useMemory,
    maxReconcileAttempts: policy.maxReconcileAttempts, onFailure: policy.onFailure,
  };
}

export class DemoCoordinator {
  private emitters = new Map<string, EventEmitter>();
  private runningSessions = new Set<string>();
  constructor(private store: Store, private agents: Agents, private observer?: OutcomeObserver, private paymentProvider: PaymentProvider = new SimulatedPaymentProvider()) {}

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
    return { run, customer, payment, episodes, policies: policies.filter(policy => policy.status === 'engineered' || policy.sourceRunId === runId), evals, activeVersion };
  }

  private async event(runId: string, phase: RunEvent['phase'], kind: string, message: string, data?: Record<string, unknown>): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error('Run not found');
    const event: RunEvent = { seq: run.events.length + 1, at: new Date().toISOString(), phase, kind, message, data: data ? structuredClone(data) : undefined };
    await this.store.appendEvent(runId, event);
    this.emitters.get(runId)?.emit('event', event);
  }

  private async observe(runId: string, session: DemoSession, version: Version, claim: 'success' | 'escalate', paymentSucceeded: boolean, entitlementActive: boolean, verified: boolean, tools: ObservedTool[]): Promise<void> {
    if (!this.observer) return;
    const phase = { v0: 'verify', v1: 'v1', v2: 'v2', v3: 'improved' } as const;
    try {
      const eventId = await this.observer.record({ runId, sessionId: session.id, version, model: this.agents.model, claim, paymentSucceeded, entitlementActive, verified, tools });
      await this.event(runId, phase[version], 'raindrop-recorded', `Raindrop ${version} outcome recorded.`, { eventId, version, signal: verified ? 'verified_recovery' : claim === 'success' ? 'false_success' : 'safe_escalation' });
    } catch {
      await this.event(runId, phase[version], 'raindrop-error', 'Raindrop telemetry failed; Atlas outcome remains authoritative.', { version });
    }
  }

  private async runEngineeredVersion(runId: string, session: DemoSession, policy: Policy, memories: Episode[] = []): Promise<void> {
    const version = policy.version;
    if (version !== 'v1' && version !== 'v2') throw new Error('Expected engineered v1 or v2 policy');
    await this.event(runId, version, 'version', `Running the same upgrade with harness ${version}.`, { version, memoryCount: memories.length, policy: policySnapshot(policy) });
    const tools: ObservedTool[] = [];
    const result = await this.agents.runTask(policy, makeTools(this.store, session, this.paymentProvider), async (tool, output) => {
      tools.push({ name: tool, result: output });
      await this.event(runId, version, 'tool', `${tool} → ${JSON.stringify(output)}`, { tool, result: output });
    }, memories);
    await this.event(runId, version, 'claim', `Task Agent ${version}: ${result.message}`, { claim: result.claim, model: result.model, prompt: result.prompt });
    const reality = await verifyReality(this.store, session, this.paymentProvider);
    const verified = result.claim === 'success' && reality.outcomeSucceeded && result.toolNames.includes('verify_entitlement');
    await this.event(runId, version, 'version-outcome', `Harness ${version}: ${result.claim}; entitlement ${reality.customer.entitlementActive ? 'active' : 'inactive'}.`, {
      version, claim: result.claim, verified, paymentSucceeded: reality.paymentSucceeded,
      entitlementActive: reality.customer.entitlementActive, toolNames: result.toolNames,
      paymentReused: (tools.find(item => item.name === 'charge_customer')?.result as { reused?: boolean } | undefined)?.reused ?? false,
      memoryCount: memories.length, model: result.model,
    });
    await this.observe(runId, session, version, result.claim, reality.paymentSucceeded, reality.customer.entitlementActive, verified, tools);
    const evaluation = evaluatePolicy(policy, runId);
    await this.store.saveEval(evaluation);
    await this.event(runId, 'eval', 'version-result', `Harness ${version} replay ${evaluation.results.filter(item => item.passed).length}/18 passed.`, { evaluation });
  }

  private async execute(runId: string, session: DemoSession): Promise<void> {
    try {
      await ensurePolicies(this.store);
      const policies = await this.store.listPolicies();
      const baselinePolicy = policyForVersion(policies, 'v0');
      await this.event(runId, 'setup', 'start', 'Same customer request. Same model. Broken provider enabled.', { model: this.agents.model, storage: this.store.mode, paymentProvider: this.paymentProvider.name });
      await this.event(runId, 'baseline', 'version', 'Harness v0 trusts tool responses.', { version: 'v0', policy: policySnapshot(baselinePolicy) });
      const baselineTools: ObservedTool[] = [];
      const baseline = await this.agents.runTask(baselinePolicy, makeTools(this.store, session, this.paymentProvider), async (tool, result) => {
        baselineTools.push({ name: tool, result });
        await this.event(runId, 'baseline', 'tool', `${tool} → ${JSON.stringify(result)}`, { tool, result });
      });
      await this.event(runId, 'baseline', 'claim', `Task Agent: ${baseline.message}`, { claim: baseline.claim, model: baseline.model, prompt: baseline.prompt });
      const observed = await verifyReality(this.store, session, this.paymentProvider);
      const baselineVerified = baseline.claim === 'success' && observed.outcomeSucceeded;
      await this.store.finishRun(runId, { baselineClaim: baseline.claim, baselineVerified });
      const reproduced = baseline.claim === 'success' && observed.paymentSucceeded && !observed.customer.entitlementActive;
      await this.event(runId, 'verify', reproduced ? 'false-success' : 'baseline-not-reproduced', reproduced ? 'FALSE SUCCESS: payment succeeded, but Maya has no Pro entitlement.' : 'Baseline did not reproduce a false-success claim.', { claim: baseline.claim, paymentSucceeded: observed.paymentSucceeded, entitlementActive: observed.customer.entitlementActive });
      await this.event(runId, 'baseline', 'version-outcome', `Harness v0: ${baseline.claim}; entitlement ${observed.customer.entitlementActive ? 'active' : 'inactive'}.`, {
        version: 'v0', claim: baseline.claim, verified: baselineVerified, paymentSucceeded: observed.paymentSucceeded,
        entitlementActive: observed.customer.entitlementActive, toolNames: baseline.toolNames,
        paymentReused: (baselineTools.find(item => item.name === 'charge_customer')?.result as { reused?: boolean } | undefined)?.reused ?? false,
        memoryCount: 0, model: baseline.model,
      });
      await this.observe(runId, session, 'v0', baseline.claim, observed.paymentSucceeded, observed.customer.entitlementActive, baselineVerified, baselineTools);
      if (!reproduced) throw new Error('Fault injection or baseline claim did not reproduce false success; reset and retry');
      const incidentSummary = 'Upgrade API returned 200 OK after payment, but customer entitlement stayed inactive. Agent claimed success. Reconciliation after payment can grant access.';
      const episode: Episode = {
        id: randomUUID(), sessionId: session.id, runId, source: 'live', version: 'v0', summary: incidentSummary,
        claim: baseline.claim, paymentSucceeded: observed.paymentSucceeded, entitlementActive: observed.customer.entitlementActive,
        createdAt: new Date().toISOString(),
      };
      await this.store.saveEpisode(episode);
      const baselineEval = evaluatePolicy(baselinePolicy, runId);
      await this.store.saveEval(baselineEval);
      await this.event(runId, 'eval', 'version-result', `Harness v0 replay ${baselineEval.results.filter(item => item.passed).length}/18 passed.`, { evaluation: baselineEval });
      await this.runEngineeredVersion(runId, session, policyForVersion(policies, 'v1'));
      const memories = (await this.store.searchEpisodes(incidentSummary, 4)).filter(memory => memory.id !== episode.id).slice(0, 3);
      if (!memories.length) throw new Error('No prior episodes retrieved from Atlas memory; run setup:atlas and wait for the index');
      await this.event(runId, 'memory', 'retrieved', `${memories.length} prior episodes retrieved from ${this.store.mode === 'atlas' ? 'Atlas Vector Search' : 'simulated memory'}.`, { memories: memories.map(({ id, summary, score, source }) => ({ id, summary, score, source })) });
      await this.runEngineeredVersion(runId, session, policyForVersion(policies, 'v2'), memories);
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
      await this.event(runId, 'improved', 'version', 'Running the same upgrade with harness v3.', { version: 'v3', policy: policySnapshot(promotedPolicy) });
      const improvedTools: ObservedTool[] = [];
      const improved = await this.agents.runTask(promotedPolicy, makeTools(this.store, session, this.paymentProvider), async (tool, result) => {
        improvedTools.push({ name: tool, result });
        await this.event(runId, 'improved', 'tool', `${tool} → ${JSON.stringify(result)}`, { tool, result });
      }, memories);
      await this.event(runId, 'improved', 'claim', `Task Agent v3: ${improved.message}`, { claim: improved.claim, model: improved.model, prompt: improved.prompt });
      const finalReality = await verifyReality(this.store, session, this.paymentProvider);
      const improvedVerified = improved.claim === 'success' && finalReality.outcomeSucceeded && improved.toolNames.includes('verify_entitlement');
      await this.event(runId, 'improved', 'version-outcome', `Harness v3: ${improved.claim}; entitlement ${finalReality.customer.entitlementActive ? 'active' : 'inactive'}.`, {
        version: 'v3', claim: improved.claim, verified: improvedVerified, paymentSucceeded: finalReality.paymentSucceeded,
        entitlementActive: finalReality.customer.entitlementActive, toolNames: improved.toolNames,
        paymentReused: (improvedTools.find(item => item.name === 'charge_customer')?.result as { reused?: boolean } | undefined)?.reused ?? false,
        memoryCount: memories.length, model: improved.model,
      });
      await this.observe(runId, session, 'v3', improved.claim, finalReality.paymentSucceeded, finalReality.customer.entitlementActive, improvedVerified, improvedTools);
      await this.store.finishRun(runId, { improvedClaim: improved.claim, improvedVerified, status: 'completed', completedAt: new Date().toISOString() });
      await this.event(runId, 'improved', improvedVerified ? 'verified-success' : 'escalated', improvedVerified ? 'VERIFIED SUCCESS: Maya has Pro access.' : 'Upgrade was not verified; escalated.', { claim: improved.claim, entitlementActive: finalReality.customer.entitlementActive, paymentSucceeded: finalReality.paymentSucceeded, prompt: improved.prompt, model: improved.model });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishRun(runId, { status: 'failed', error: message, completedAt: new Date().toISOString() });
      await this.event(runId, 'system', 'error', message);
    }
  }
}
