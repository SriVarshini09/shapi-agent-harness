import { describe, expect, it } from 'vitest';
import { deriveEvolution, deriveFaultEvidence, type EvolutionEvent } from './evolution-state';

const event = (phase: string, kind: string, data?: Record<string, unknown>): EvolutionEvent => ({ phase, kind, data });

describe('judge-facing fault and evolution view', () => {
  it('does not present a planned fault as an observed failure', () => {
    expect(deriveFaultEvidence([], true)).toMatchObject({ upgrade: 'WILL RETURN 200 OK', entitlement: 'WRITE WILL BE SKIPPED', mismatch: false });
    expect(deriveEvolution([]).every(step => step.stage === 'waiting')).toBe(true);
  });

  it('shows the real v0 mismatch and the changes added by v1 and v2', () => {
    const events = [
      event('baseline', 'version', { version: 'v0' }),
      event('baseline', 'tool', { tool: 'charge_customer', result: { provider: 'stripe-test', paymentId: 'pi_test' } }),
      event('baseline', 'tool', { tool: 'upgrade_customer', result: { status: 200 } }),
      event('verify', 'false-success', { entitlementActive: false }),
      event('baseline', 'version-outcome', { version: 'v0', claim: 'success', entitlementActive: false, verified: false, memoryCount: 0, toolNames: ['charge_customer', 'upgrade_customer'] }),
      event('eval', 'version-result', { evaluation: { version: 'v0', results: Array.from({ length: 18 }, (_, i) => ({ passed: i < 5 })) } }),
      event('v1', 'version', { version: 'v1' }),
    ];
    expect(deriveFaultEvidence(events, true)).toMatchObject({ payment: 'STRIPE TEST PAYMENT SUCCEEDED', paymentId: 'pi_test', upgrade: 'RETURNED 200', entitlement: 'INACTIVE AFTER 200 OK', mismatch: true });
    const steps = deriveEvolution(events);
    expect(steps[0]).toMatchObject({ result: 'FALSE SUCCESS', replay: '5/18', access: 'PRO LOCKED' });
    expect(steps[1]).toMatchObject({ stage: 'running', capability: '+ verify_entitlement' });
    expect(steps[2]).toMatchObject({ stage: 'waiting', capability: '+ Atlas episode retrieval' });
  });

  it('shows model proposal as in progress until a live v3 outcome exists', () => {
    const events = [event('propose', 'candidate'), event('eval', 'results', { evaluation: { version: 'v3', results: Array.from({ length: 18 }, () => ({ passed: false })) } })];
    expect(deriveEvolution(events)[3]).toMatchObject({ stage: 'running', result: 'PROPOSING + REPLAYING', replay: '0/18' });
    events.push(event('improved', 'version', { version: 'v3' }));
    events.push(event('improved', 'version-outcome', { version: 'v3', claim: 'success', entitlementActive: true, verified: true, memoryCount: 3, toolNames: ['verify_entitlement', 'reconcile_entitlement', 'verify_entitlement'] }));
    events.push(event('improved', 'verified-success'));
    expect(deriveEvolution(events)[3]).toMatchObject({ stage: 'complete', result: 'VERIFIED RECOVERY', memoryHits: 3 });
    expect(deriveFaultEvidence(events, true).recovered).toBe(true);
  });

  it('keeps live tool calls and claims under their own version, including proposal evidence for v3', () => {
    const events: EvolutionEvent[] = [
      { seq: 2, phase: 'baseline', kind: 'version', message: 'Harness v0 trusts tool responses.' },
      { seq: 3, phase: 'baseline', kind: 'tool', message: 'charge_customer → {"status":200}' },
      { seq: 4, phase: 'baseline', kind: 'tool', message: 'upgrade_customer → {"status":200}' },
      { seq: 5, phase: 'baseline', kind: 'claim', message: 'Task Agent: upgraded.' },
      { seq: 6, phase: 'verify', kind: 'false-success', message: 'FALSE SUCCESS: access inactive.' },
      { seq: 10, phase: 'v1', kind: 'version', message: 'Running v1.' },
      { seq: 11, phase: 'v1', kind: 'tool', message: 'charge_customer → {"reused":true}' },
      { seq: 12, phase: 'v1', kind: 'claim', message: 'Task Agent v1: escalated.' },
      { seq: 14, phase: 'memory', kind: 'retrieved', message: '3 prior episodes retrieved.' },
      { seq: 15, phase: 'v2', kind: 'version', message: 'Running v2.' },
      { seq: 16, phase: 'v2', kind: 'tool', message: 'verify_entitlement → {"entitlementActive":false}' },
      { seq: 20, phase: 'propose', kind: 'candidate', message: 'Policy candidate stored.' },
      { seq: 21, phase: 'eval', kind: 'results', message: 'Replay 18/18 passed.' },
      { seq: 22, phase: 'promote', kind: 'promoted', message: 'Harness v3 promoted.' },
      { seq: 23, phase: 'improved', kind: 'version', message: 'Running v3.' },
      { seq: 24, phase: 'improved', kind: 'tool', message: 'reconcile_entitlement → {"entitlementActive":true}' },
      { seq: 25, phase: 'improved', kind: 'claim', message: 'Task Agent v3: verified success.' },
    ];
    const [v0, v1, v2, v3] = deriveEvolution(events);
    expect(v0.trace.map(item => item.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(v1.trace.map(item => item.seq)).toEqual([10, 11, 12]);
    expect(v2.trace.map(item => item.seq)).toEqual([14, 15, 16]);
    expect(v3.trace.map(item => item.seq)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(v1.trace[1].message).toContain('"reused":true');
    expect(v3.trace.some(item => item.message.includes('FALSE SUCCESS'))).toBe(false);
  });

  it('shows the stored v3 outcome as a claim for runs created before claim events existed', () => {
    const oldRun = [event('improved', 'version-outcome', { version: 'v3', claim: 'success', verified: true })];
    expect(deriveEvolution(oldRun)[3].trace.map(item => item.kind)).toEqual(['version-outcome']);
  });
});
