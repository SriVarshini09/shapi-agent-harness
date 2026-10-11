import { randomUUID } from 'node:crypto';
import type { Claim, Version } from './types.js';

export interface ObservedTool {
  name: string;
  result: unknown;
}

export interface ObservedOutcome {
  runId: string;
  sessionId: string;
  version: Version;
  model: string;
  claim: Claim;
  paymentSucceeded: boolean;
  entitlementActive: boolean;
  verified: boolean;
  tools: ObservedTool[];
}

export interface OutcomeObserver {
  record(outcome: ObservedOutcome): Promise<string>;
  close(): Promise<void>;
}

// Only outcome booleans and tool names leave the server; no customer name,
// email, payment ID, model prompt, database URI, or API key is sent.
function safeToolResult(result: unknown): Record<string, boolean | number> {
  if (!result || typeof result !== 'object') return {};
  const source = result as Record<string, unknown>;
  const safe: Record<string, boolean | number> = {};
  for (const key of ['status', 'reused', 'paymentSucceeded', 'entitlementActive']) {
    if (typeof source[key] === 'boolean' || typeof source[key] === 'number') safe[key] = source[key] as boolean | number;
  }
  return safe;
}

export async function createRaindropObserver(writeKey: string, projectId?: string): Promise<OutcomeObserver> {
  const { Raindrop } = await import('raindrop-ai');
  const client = new Raindrop({
    writeKey,
    projectId: projectId || undefined,
    redactPii: true,
    bufferSize: 1,
    disableBatching: true,
    bypassOtelForTools: true,
    localWorkshopUrl: false,
  });
  return {
    async record(outcome) {
      const eventId = randomUUID();
      const interaction = client.begin({
        eventId,
        event: 'shapi_upgrade_outcome',
        userId: outcome.sessionId,
        convoId: outcome.runId,
        input: 'Upgrade customer to Pro',
        model: outcome.model,
        featureFlags: { harness_version: outcome.version },
        properties: {
          run_id: outcome.runId,
          harness_version: outcome.version,
          agent_claim: outcome.claim,
          payment_succeeded: outcome.paymentSucceeded,
          entitlement_active: outcome.entitlementActive,
          verified: outcome.verified,
        },
      });
      for (const tool of outcome.tools) interaction.trackTool({ name: tool.name, output: safeToolResult(tool.result) });
      await interaction.finish({ output: outcome.claim, properties: { verified: outcome.verified } });
      const signal = outcome.verified ? 'verified_recovery' : outcome.claim === 'success' ? 'false_success' : 'safe_escalation';
      client.trackSignal({
        eventId,
        name: signal,
        sentiment: outcome.verified || signal === 'safe_escalation' ? 'POSITIVE' : 'NEGATIVE',
        properties: { run_id: outcome.runId, harness_version: outcome.version },
      });
      return eventId;
    },
    async close() { await client.close(); },
  };
}
