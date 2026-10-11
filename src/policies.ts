import { randomUUID } from 'node:crypto';
import type { Policy, Store, Version } from './types.js';

export const initialPolicies: Policy[] = [
  { id: 'engineered-v0', version: 'v0', parentVersion: null, requireVerification: false, useMemory: false, maxReconcileAttempts: 0, onFailure: 'escalate', explanation: 'Trust the upgrade API response.', status: 'engineered', createdAt: '2026-10-11T00:00:00.000Z' },
  { id: 'engineered-v1', version: 'v1', parentVersion: 'v0', requireVerification: true, useMemory: false, maxReconcileAttempts: 0, onFailure: 'escalate', explanation: 'Verify payment and entitlement before claiming success.', status: 'engineered', createdAt: '2026-10-11T00:00:01.000Z' },
  { id: 'engineered-v2', version: 'v2', parentVersion: 'v1', requireVerification: true, useMemory: true, maxReconcileAttempts: 0, onFailure: 'escalate', explanation: 'Retrieve similar failure episodes before proposing a policy.', status: 'engineered', createdAt: '2026-10-11T00:00:02.000Z' },
];

export async function ensurePolicies(store: Store): Promise<void> {
  const existing = new Set((await store.listPolicies()).map(policy => policy.id));
  for (const policy of initialPolicies) if (!existing.has(policy.id)) await store.savePolicy(policy);
}

export function candidatePolicy(input: { maxReconcileAttempts: 0 | 1; explanation: string }, runId: string, model: string, prompt: string): Policy {
  return {
    id: randomUUID(), version: 'v3', parentVersion: 'v2',
    requireVerification: true, useMemory: true,
    maxReconcileAttempts: input.maxReconcileAttempts, onFailure: 'escalate',
    explanation: input.explanation, status: 'candidate', sourceRunId: runId,
    model, prompt, createdAt: new Date().toISOString(),
  };
}

export function policyForVersion(policies: Policy[], version: Version): Policy {
  const match = policies.find(policy => policy.version === version && policy.status !== 'rejected');
  if (!match) throw new Error(`No policy for ${version}`);
  return match;
}
