import { describe, expect, it } from 'vitest';
import { SimulatedAgents } from './agents.js';
import { DemoCoordinator } from './demo.js';
import { evaluatePolicy, fixtures } from './evals.js';
import { MemoryStore } from './memory-store.js';
import { candidatePolicy, initialPolicies } from './policies.js';
import { seedHistory } from './seed.js';
import { makeTools, verifyReality } from './simulator.js';
import type { ObservedOutcome, OutcomeObserver } from './raindrop.js';

describe('provider failure and payment safety', () => {
  it('returns 200 while access remains locked, then reconciles without a second payment', async () => {
    const store = new MemoryStore();
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const tools = makeTools(store, { ...session, fault: 'silent' });
    const first = await tools.charge_customer();
    expect((await tools.upgrade_customer()).status).toBe(200);
    expect((await verifyReality(store, session)).outcomeSucceeded).toBe(false);
    const second = await tools.charge_customer();
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.reused).toBe(true);
    await tools.reconcile_entitlement();
    expect((await tools.verify_entitlement()).entitlementActive).toBe(true);
  });

  it('does not reconcile without a successful payment', async () => {
    const store = new MemoryStore();
    const session = await store.createSession();
    await expect(makeTools(store, session).reconcile_entitlement()).rejects.toThrow('successful payment');
  });
});

describe('deterministic promotion gate', () => {
  it('has 18 distinct fixtures across six categories', () => {
    expect(fixtures).toHaveLength(18);
    expect(new Set(fixtures.map(item => item.id)).size).toBe(18);
    expect(new Set(fixtures.map(item => item.category)).size).toBe(6);
  });

  it('rejects v0 and a no-recovery proposal, then accepts bounded recovery', () => {
    const v0 = evaluatePolicy(initialPolicies[0], 'test');
    const noRecovery = evaluatePolicy(candidatePolicy({ maxReconcileAttempts: 0, explanation: 'Verify before reporting completion.' }, 'test', 'test', 'test'), 'test');
    const recovery = evaluatePolicy(candidatePolicy({ maxReconcileAttempts: 1, explanation: 'Verify, reconcile once, then verify again.' }, 'test', 'test', 'test'), 'test');
    expect(v0.passed).toBe(false);
    expect(v0.results.some(item => item.falseSuccess)).toBe(true);
    expect(noRecovery.passed).toBe(false);
    expect(recovery.passed).toBe(true);
    expect(recovery.results).toHaveLength(18);
    expect(recovery.results.every(item => item.passed && item.chargeCount === 1)).toBe(true);
    expect(recovery.results.filter(item => item.claim === 'escalate')).toHaveLength(5);
  });

  it('does not move the active pointer for a candidate with a failed eval', async () => {
    const store = new MemoryStore();
    const session = await store.createSession();
    const candidate = candidatePolicy({ maxReconcileAttempts: 0, explanation: 'Verify and escalate if access is inactive.' }, 'test', 'test', 'test');
    await store.savePolicy(candidate);
    await store.saveEval(evaluatePolicy(candidate, 'test'));
    expect(await store.promotePolicy(session.id, 'v2', candidate.id)).toBe(false);
    expect(await store.getActiveVersion(session.id)).toBe('v2');
  });
});

describe('full coordinator flow', () => {
  it('records all four live agent outcomes without letting telemetry govern promotion', async () => {
    const store = new MemoryStore();
    await seedHistory(store);
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const outcomes: ObservedOutcome[] = [];
    const observer: OutcomeObserver = { async record(outcome) { outcomes.push(outcome); return `event-${outcomes.length}`; }, async close() {} };
    const coordinator = new DemoCoordinator(store, new SimulatedAgents(), observer);
    const runId = await coordinator.start(session.id);
    for (let attempt = 0; attempt < 100 && (await store.getRun(runId))?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const evidence = await coordinator.evidence(runId);
    expect(evidence.run.status).toBe('completed');
    expect(outcomes.map(item => [item.version, item.claim, item.verified])).toEqual([['v0', 'success', false], ['v1', 'escalate', false], ['v2', 'escalate', false], ['v3', 'success', true]]);
    expect(outcomes[0].tools.map(tool => tool.name)).toContain('upgrade_customer');
    expect(outcomes[1].tools.map(tool => tool.name)).not.toContain('reconcile_entitlement');
    expect(outcomes[2].tools.map(tool => tool.name)).not.toContain('reconcile_entitlement');
    expect(outcomes[3].tools.map(tool => tool.name)).toContain('reconcile_entitlement');
    expect(evidence.run.events.filter(item => item.kind === 'raindrop-recorded')).toHaveLength(4);
    const liveOutcomes = evidence.run.events.filter(item => item.kind === 'version-outcome').map(item => item.data);
    expect(liveOutcomes.map(item => item?.version)).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(liveOutcomes.map(item => item?.entitlementActive)).toEqual([false, false, false, true]);
    expect(liveOutcomes.map(item => item?.paymentReused)).toEqual([false, true, true, true]);
    expect(liveOutcomes.map(item => item?.memoryCount)).toEqual([0, 0, 3, 3]);
    expect(evidence.activeVersion).toBe('v3');
  });

  it('continues the demo when Raindrop telemetry fails', async () => {
    const store = new MemoryStore();
    await seedHistory(store);
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const observer: OutcomeObserver = { async record() { throw new Error('network unavailable'); }, async close() {} };
    const coordinator = new DemoCoordinator(store, new SimulatedAgents(), observer);
    const runId = await coordinator.start(session.id);
    for (let attempt = 0; attempt < 100 && (await store.getRun(runId))?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const evidence = await coordinator.evidence(runId);
    expect(evidence.run.status).toBe('completed');
    expect(evidence.run.events.filter(item => item.kind === 'raindrop-error')).toHaveLength(4);
    expect(evidence.activeVersion).toBe('v3');
  });

  it('stores the rejected and promoted proposals, evidence, and v3 result', async () => {
    const store = new MemoryStore();
    await seedHistory(store);
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const coordinator = new DemoCoordinator(store, new SimulatedAgents());
    const runId = await coordinator.start(session.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await store.getRun(runId);
      if (run?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const evidence = await coordinator.evidence(runId);
    expect(evidence.run.status).toBe('completed');
    expect(evidence.run.baselineClaim).toBe('success');
    expect(evidence.run.baselineVerified).toBe(false);
    expect(evidence.run.improvedVerified).toBe(true);
    expect(evidence.activeVersion).toBe('v3');
    expect(evidence.customer.entitlementActive).toBe(true);
    expect(evidence.payment?.succeeded).toBe(true);
    expect(evidence.episodes).toHaveLength(1);
    expect(evidence.evals.map(item => item.version)).toEqual(['v0', 'v1', 'v2', 'v3', 'v3']);
    expect(evidence.evals.filter(item => item.version === 'v3').map(item => item.passed)).toEqual([false, true]);
    expect(evidence.policies.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(evidence.policies.filter(item => item.status === 'promoted')).toHaveLength(1);
    expect(evidence.run.events.some(item => item.kind === 'retrieved')).toBe(true);
  });

  it('never promotes when both bounded proposals fail replay', async () => {
    const store = new MemoryStore();
    await seedHistory(store);
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const agents = new SimulatedAgents();
    agents.propose = async () => ({ proposal: { requireVerification: true, maxReconcileAttempts: 0, onFailure: 'escalate', explanation: 'Verify independently, then escalate if inactive.' }, prompt: 'test proposer', model: 'simulated-agent' });
    const coordinator = new DemoCoordinator(store, agents);
    const runId = await coordinator.start(session.id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = await store.getRun(runId);
      if (run?.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const evidence = await coordinator.evidence(runId);
    expect(evidence.run.status).toBe('failed');
    expect(evidence.activeVersion).toBe('v2');
    expect(evidence.evals.filter(item => item.version === 'v3')).toHaveLength(2);
    expect(evidence.evals.filter(item => item.version === 'v3').every(item => !item.passed)).toBe(true);
    expect(evidence.policies.filter(item => item.version === 'v3').every(item => item.status === 'rejected')).toBe(true);
    expect(evidence.customer.entitlementActive).toBe(false);
  });
});
