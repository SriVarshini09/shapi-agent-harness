import { describe, expect, it } from 'vitest';
import { deriveLiveFlow, type FlowEvent } from './flow-state';

const event = (seq: number, phase: string, kind: string, data?: Record<string, unknown>): FlowEvent => ({ seq, phase, kind, data });

describe('live flow map', () => {
  it('shows only observed work before a run', () => {
    const initial = deriveLiveFlow([], false);
    expect(initial).toHaveLength(8);
    expect(initial.every(step => step.status === 'waiting')).toBe(true);
    expect(deriveLiveFlow([], true)[1]).toMatchObject({ status: 'running', detail: 'Silent failure armed' });
  });

  it('shows a detected false success and measured memory and replay', () => {
    const events = [
      event(1, 'setup', 'start'),
      event(2, 'baseline', 'tool', { tool: 'upgrade_customer', result: { status: 200 } }),
      event(3, 'baseline', 'claim', { claim: 'success' }),
      event(4, 'verify', 'false-success'),
      event(5, 'memory', 'retrieved', { memories: [{ id: 'a' }, { id: 'b' }] }),
      event(6, 'propose', 'candidate'),
      event(7, 'eval', 'results', { evaluation: { results: Array.from({ length: 18 }, (_, index) => ({ passed: index !== 0 })) } }),
    ];
    const steps = deriveLiveFlow(events, true);
    expect(steps[1].detail).toBe('Returned 200');
    expect(steps[2]).toMatchObject({ status: 'issue', detail: 'Paid; Pro access inactive' });
    expect(steps[3].detail).toBe('False success detected');
    expect(steps[4].detail).toBe('2 prior episodes retrieved');
    expect(steps[6]).toMatchObject({ status: 'issue', detail: '17/18 passed; revising' });
    expect(steps[7].status).toBe('waiting');
  });

  it('marks recovery done only after the real verification event', () => {
    const events = [
      event(1, 'promote', 'promoted'),
      event(2, 'improved', 'tool', { tool: 'reconcile_entitlement', result: { status: 200 } }),
    ];
    expect(deriveLiveFlow(events, true)[7]).toMatchObject({ status: 'running', detail: 'Reconciled; verifying…' });
    events.push(event(3, 'improved', 'verified-success'));
    expect(deriveLiveFlow(events, true)[7]).toMatchObject({ status: 'done', detail: 'Pro access independently verified' });
  });
});
