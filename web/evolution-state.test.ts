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
});
