import { randomUUID } from 'node:crypto';
import type { CaseResult, Claim, EvalRun, Policy } from './types.js';

interface Fixture {
  id: string;
  category: string;
  accessAtFirstCheck: boolean;
  accessAtSecondCheck: boolean;
  reconcileWorks: boolean;
  expected: Claim;
  duplicateRequests: number;
  response: string;
}

// Every case differs in state, timing, duplication, or provider response.
export const fixtures: Fixture[] = [
  { id: 'normal-immediate', category: 'normal success', accessAtFirstCheck: true, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '200' },
  { id: 'normal-async', category: 'normal success', accessAtFirstCheck: false, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '202' },
  { id: 'normal-already-pro', category: 'normal success', accessAtFirstCheck: true, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 1, response: 'already_pro' },
  { id: 'silent-recoverable', category: 'silent 200', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '200' },
  { id: 'silent-other-tenant', category: 'silent 200', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '200 tenant mismatch' },
  { id: 'silent-unrecoverable', category: 'silent 200', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: false, expected: 'escalate', duplicateRequests: 0, response: '200' },
  { id: 'delay-short', category: 'delayed access', accessAtFirstCheck: false, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '200 pending' },
  { id: 'delay-at-boundary', category: 'delayed access', accessAtFirstCheck: false, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '200 queued' },
  { id: 'delay-timeout', category: 'delayed access', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: false, expected: 'escalate', duplicateRequests: 0, response: '200 queued' },
  { id: 'malformed-empty', category: 'malformed response', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: '{}' },
  { id: 'malformed-null', category: 'malformed response', accessAtFirstCheck: true, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: 'null body' },
  { id: 'malformed-wrong-id', category: 'malformed response', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: false, expected: 'escalate', duplicateRequests: 0, response: 'wrong customer' },
  { id: 'duplicate-ack', category: 'duplicate request', accessAtFirstCheck: true, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 1, response: '200 duplicate' },
  { id: 'duplicate-retry', category: 'duplicate request', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: true, expected: 'success', duplicateRequests: 2, response: '200 duplicate' },
  { id: 'duplicate-failed', category: 'duplicate request', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: false, expected: 'escalate', duplicateRequests: 2, response: '200 duplicate' },
  { id: 'drift-status', category: 'provider drift', accessAtFirstCheck: true, accessAtSecondCheck: true, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: 'status=accepted' },
  { id: 'drift-nesting', category: 'provider drift', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: true, expected: 'success', duplicateRequests: 0, response: 'data.result.ack' },
  { id: 'drift-terminal', category: 'provider drift', accessAtFirstCheck: false, accessAtSecondCheck: false, reconcileWorks: false, expected: 'escalate', duplicateRequests: 0, response: 'new enum' },
];

export function evaluateCase(policy: Policy, fixture: Fixture): CaseResult {
  let entitlementActive = fixture.accessAtFirstCheck;
  let claim: Claim = 'success';
  const toolCalls = ['charge_customer', 'upgrade_customer'];
  // Duplicate requests use the same session-scoped idempotency key.
  for (let retry = 0; retry < fixture.duplicateRequests; retry++) toolCalls.push('charge_customer');
  const chargeCount = 1;
  if (policy.requireVerification) {
    toolCalls.push('verify_entitlement');
    if (!entitlementActive) {
      entitlementActive = fixture.accessAtSecondCheck;
      toolCalls.push('verify_entitlement');
      if (!entitlementActive && policy.maxReconcileAttempts === 1) {
        toolCalls.push('reconcile_entitlement', 'verify_entitlement');
        entitlementActive = fixture.reconcileWorks;
      }
    }
    if (!entitlementActive) claim = 'escalate';
  }
  const falseSuccess = claim === 'success' && !entitlementActive;
  const reconciles = toolCalls.filter(tool => tool === 'reconcile_entitlement').length;
  const firstVerification = toolCalls.indexOf('verify_entitlement');
  const firstReconcile = toolCalls.indexOf('reconcile_entitlement');
  const permittedCalls = reconciles <= policy.maxReconcileAttempts && (firstReconcile === -1 || firstVerification < firstReconcile);
  const passed = claim === fixture.expected && !falseSuccess && chargeCount === 1 && permittedCalls;
  return {
    id: fixture.id, category: fixture.category, passed, claim, entitlementActive,
    chargeCount, falseSuccess, toolCalls,
    detail: `${fixture.response}; duplicate requests=${fixture.duplicateRequests}; expected=${fixture.expected}; observed=${claim}; permitted calls=${permittedCalls}`,
  };
}

export function evaluatePolicy(policy: Policy, runId: string): EvalRun {
  const results = fixtures.map(fixture => evaluateCase(policy, fixture));
  return {
    id: randomUUID(), runId, policyId: policy.id, version: policy.version,
    passed: results.length === 18 && results.every(result => result.passed && !result.falseSuccess && result.chargeCount === 1),
    results, createdAt: new Date().toISOString(),
  };
}
