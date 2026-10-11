import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIAgents } from './agents.js';
import { MemoryStore } from './memory-store.js';
import { candidatePolicy, initialPolicies } from './policies.js';
import { makeTools } from './simulator.js';

const model = 'gpt-6-luna';
const policy = candidatePolicy({ maxReconcileAttempts: 1, explanation: 'Verify, reconcile once, and verify again.' }, 'test', model, 'test');

function call(name: string, id: string) {
  return { type: 'function_call', name, call_id: id, arguments: '{}' };
}

function response(id: string, calls: ReturnType<typeof call>[]) {
  return { id, model, output: calls, output_text: '' };
}

function final(claim: 'success' | 'escalate') {
  return { id: 'final', model, output: [], output_text: JSON.stringify({ claim, message: 'The upgrade is complete.' }) };
}

function scripted(responses: object[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected model request');
    return next;
  });
  const agent = new OpenAIAgents(model, 'test-key', { responses: { create } } as unknown as Pick<OpenAI, 'responses'>);
  return { agent, create };
}

async function setup() {
  const store = new MemoryStore();
  const session = await store.createSession();
  await store.setFault(session.id, 'silent');
  return { store, session: { ...session, fault: 'silent' as const }, trace: vi.fn(async () => {}) };
}

describe('OpenAI Responses tool loop', () => {
  it('chains call IDs and re-sends instructions while exposing the v0 false success', async () => {
    const { store, session, trace } = await setup();
    const { agent, create } = scripted([
      response('r1', [call('charge_customer', 'c1')]),
      response('r2', [call('upgrade_customer', 'c2')]),
      final('success'),
    ]);
    const outcome = await agent.runTask(initialPolicies[0], makeTools(store, session), trace);
    expect(outcome.claim).toBe('success');
    expect((await store.getCustomer(session.customerId)).entitlementActive).toBe(false);
    expect(outcome.toolNames).toEqual(['charge_customer', 'upgrade_customer']);
    expect(create).toHaveBeenCalledTimes(3);
    const requests = create.mock.calls.map(([request]) => request as Record<string, unknown>);
    expect(requests.map(request => request.previous_response_id)).toEqual([undefined, 'r1', 'r2']);
    expect(requests.map(request => (request.input as { call_id?: string }[])[0].call_id)).toEqual([undefined, 'c1', 'c2']);
    expect(requests.every(request => request.instructions === outcome.prompt)).toBe(true);
    expect((requests[0].tools as { name: string }[]).map(tool => tool.name)).toEqual(['charge_customer', 'upgrade_customer']);
    expect(trace).toHaveBeenCalledTimes(2);
  });

  it('recovers with one reconciliation and verifies again without a second charge', async () => {
    const { store, session, trace } = await setup();
    const firstPayment = await makeTools(store, session).charge_customer();
    const { agent, create } = scripted([
      response('r1', [call('charge_customer', 'c1')]),
      response('r2', [call('upgrade_customer', 'c2')]),
      response('r3', [call('verify_entitlement', 'c3')]),
      response('r4', [call('reconcile_entitlement', 'c4')]),
      response('r5', [call('verify_entitlement', 'c5')]),
      final('success'),
    ]);
    const outcome = await agent.runTask(policy, makeTools(store, session), trace);
    expect(outcome.claim).toBe('success');
    expect(outcome.toolNames).toEqual(['charge_customer', 'upgrade_customer', 'verify_entitlement', 'reconcile_entitlement', 'verify_entitlement']);
    expect((await store.getCustomer(session.customerId)).entitlementActive).toBe(true);
    expect((await store.getPayment(session.id))?.id).toBe(firstPayment.paymentId);
    expect(trace.mock.calls[0][1].reused).toBe(true);
    expect(create).toHaveBeenCalledTimes(6);
  });

  it('downgrades success when no post-upgrade verification occurred', async () => {
    const { store, session, trace } = await setup();
    const { agent } = scripted([
      response('r1', [call('charge_customer', 'c1')]),
      response('r2', [call('upgrade_customer', 'c2')]),
      final('success'),
    ]);
    const outcome = await agent.runTask(policy, makeTools(store, session), trace);
    expect(outcome.claim).toBe('escalate');
    expect((await store.getCustomer(session.customerId)).entitlementActive).toBe(false);
  });

  it('rejects verification before the upgrade and reconciliation before a failed check', async () => {
    const { store, session, trace } = await setup();
    const prematureCheck = scripted([response('r1', [call('verify_entitlement', 'c1')])]);
    await expect(prematureCheck.agent.runTask(policy, makeTools(store, session), trace)).rejects.toThrow('Verification requires an upgrade attempt');
    const prematureReconcile = scripted([
      response('r1', [call('charge_customer', 'c1')]),
      response('r2', [call('upgrade_customer', 'c2')]),
      response('r3', [call('reconcile_entitlement', 'c3')]),
    ]);
    await expect(prematureReconcile.agent.runTask(policy, makeTools(store, session), trace)).rejects.toThrow('failed independent verification');
    expect((await store.getCustomer(session.customerId)).entitlementActive).toBe(false);
  });

  it('rejects a second reconciliation attempt', async () => {
    const { store, session, trace } = await setup();
    const { agent } = scripted([
      response('r1', [call('charge_customer', 'c1')]),
      response('r2', [call('upgrade_customer', 'c2')]),
      response('r3', [call('verify_entitlement', 'c3')]),
      response('r4', [call('reconcile_entitlement', 'c4')]),
      response('r5', [call('reconcile_entitlement', 'c5')]),
    ]);
    await expect(agent.runTask(policy, makeTools(store, session), trace)).rejects.toThrow('Reconciliation attempt limit exceeded');
  });

  it('rejects unsupported policy output from the proposer', async () => {
    const { agent } = scripted([{ id: 'r1', model, output: [], output_text: JSON.stringify({ requireVerification: false, maxReconcileAttempts: 2, onFailure: 'success', explanation: 'Skip the check.' }) }]);
    await expect(agent.propose('silent failure', [], [])).rejects.toThrow();
  });
});
