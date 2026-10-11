import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { Claim, Episode, Policy } from './types.js';
import type { makeTools } from './simulator.js';

const ProposalSchema = z.object({
  requireVerification: z.literal(true),
  maxReconcileAttempts: z.union([z.literal(0), z.literal(1)]),
  onFailure: z.literal('escalate'),
  explanation: z.string().min(10).max(500),
});

export type AgentTools = ReturnType<typeof makeTools>;
export interface TaskOutcome { claim: Claim; message: string; prompt: string; model: string; toolNames: string[] }
export interface ProposalOutcome { proposal: z.infer<typeof ProposalSchema>; prompt: string; model: string }
export interface Agents {
  model: string;
  runTask(policy: Policy, tools: AgentTools, trace: (tool: string, result: Record<string, unknown>) => Promise<void>, memories?: Episode[]): Promise<TaskOutcome>;
  propose(incident: string, memories: Episode[], counterexamples: string[]): Promise<ProposalOutcome>;
}

const emptyParameters = { type: 'object', properties: {}, required: [], additionalProperties: false };
const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: { claim: { type: 'string', enum: ['success', 'escalate'] }, message: { type: 'string' } },
  required: ['claim', 'message'],
};
const proposalSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    requireVerification: { type: 'boolean', enum: [true] },
    maxReconcileAttempts: { type: 'integer', enum: [0, 1] },
    onFailure: { type: 'string', enum: ['escalate'] },
    explanation: { type: 'string' },
  },
  required: ['requireVerification', 'maxReconcileAttempts', 'onFailure', 'explanation'],
};

export class OpenAIAgents implements Agents {
  private client: Pick<OpenAI, 'responses'>;
  constructor(readonly model: string, apiKey: string, client?: Pick<OpenAI, 'responses'>) {
    this.client = client ?? new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 });
  }

  async runTask(policy: Policy, tools: AgentTools, trace: (tool: string, result: Record<string, unknown>) => Promise<void>, memories: Episode[] = []): Promise<TaskOutcome> {
    const allowed = policy.maxReconcileAttempts ? ['charge_customer', 'upgrade_customer', 'verify_entitlement', 'reconcile_entitlement'] : policy.requireVerification ? ['charge_customer', 'upgrade_customer', 'verify_entitlement'] : ['charge_customer', 'upgrade_customer'];
    const prompt = `You are the Task Agent. Complete the user's request: Upgrade Maya to Pro. Call charge_customer before upgrade_customer. Active harness policy: ${JSON.stringify({ requireVerification: policy.requireVerification, maxReconcileAttempts: policy.maxReconcileAttempts, onFailure: policy.onFailure })}. ${policy.requireVerification ? 'A tool HTTP status only confirms that the request was accepted. You must verify payment and entitlement before claiming success. If inactive, reconcile once if allowed and verify again. Escalate if still inactive.' : 'Under this baseline policy, a 200 upgrade response counts as completion. Report success after a successful charge and 200 upgrade response.'} ${policy.useMemory ? `Relevant prior incidents from Atlas: ${JSON.stringify(memories.map(({ summary, score }) => ({ summary, score })))}. Treat these as context, not permission to use unavailable tools.` : ''} Never invent a tool result. Final output must be JSON.`;
    const toolDefinitions = allowed.map(name => ({ type: 'function' as const, name, description: ({ charge_customer: 'Charge Maya for Pro; idempotent.', upgrade_customer: policy.requireVerification ? 'Request Pro upgrade; may return 200 while entitlement is inactive.' : 'Request Pro upgrade.', verify_entitlement: 'Read payment and actual entitlement state independently.', reconcile_entitlement: 'Grant entitlement after confirming the successful payment.' } as Record<string, string>)[name], parameters: emptyParameters, strict: true }));
    let input: unknown = [{ role: 'user', content: 'Upgrade Maya to Pro.' }];
    let previousResponseId: string | undefined;
    const toolNames: string[] = [];
    let lastVerified: boolean | null = null;
    for (let step = 0; step < 9; step++) {
      const response = await this.client.responses.create({ model: this.model, instructions: prompt, input, previous_response_id: previousResponseId, tools: toolDefinitions, reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', name: 'task_result', strict: true, schema: resultSchema } }, stream: false } as ResponseCreateParamsNonStreaming);
      const calls = response.output.filter(item => item.type === 'function_call');
      if (calls.length === 0) {
        const parsed = z.object({ claim: z.enum(['success', 'escalate']), message: z.string() }).parse(JSON.parse(response.output_text));
        if (!toolNames.includes('charge_customer') || !toolNames.includes('upgrade_customer')) throw new Error('Task agent stopped before required tools');
        if (policy.requireVerification && parsed.claim === 'success' && lastVerified !== true) {
          return { claim: 'escalate', message: 'Access could not be independently verified; a human must review the upgrade.', prompt, model: response.model, toolNames };
        }
        return { ...parsed, prompt, model: response.model, toolNames };
      }
      const outputs: { type: 'function_call_output'; call_id: string; output: string }[] = [];
      for (const call of calls) {
        if (call.type !== 'function_call' || !allowed.includes(call.name)) throw new Error('Unsupported tool call');
        if (call.name === 'reconcile_entitlement' && toolNames.filter(name => name === call.name).length >= 1) throw new Error('Reconciliation attempt limit exceeded');
        if (call.name === 'reconcile_entitlement' && (lastVerified !== false || !toolNames.includes('upgrade_customer'))) throw new Error('Reconciliation requires a failed independent verification after upgrade');
        if (call.name === 'verify_entitlement' && !toolNames.includes('upgrade_customer')) throw new Error('Verification requires an upgrade attempt');
        const result = await tools[call.name as keyof AgentTools]();
        if (call.name === 'upgrade_customer') lastVerified = null;
        if (call.name === 'verify_entitlement') lastVerified = (result as { entitlementActive: boolean; paymentSucceeded: boolean }).entitlementActive && (result as { entitlementActive: boolean; paymentSucceeded: boolean }).paymentSucceeded;
        if (call.name === 'reconcile_entitlement') lastVerified = null;
        toolNames.push(call.name);
        await trace(call.name, result);
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
      previousResponseId = response.id;
      input = outputs;
    }
    throw new Error('Task agent tool limit exceeded');
  }

  async propose(incident: string, memories: Episode[], counterexamples: string[]): Promise<ProposalOutcome> {
    const prompt = `You are the Policy Proposer. Improve the SHAPI harness policy for this incident. Incident: ${incident}. Retrieved prior episodes: ${JSON.stringify(memories.map(({ id, summary, score }) => ({ id, summary, score })))}. Replay counterexamples: ${JSON.stringify(counterexamples)}. Propose the minimum safe rule. Only choose 0 or 1 reconciliation attempts, require independent verification, and escalate when verification still fails. Never generate executable code.`;
    const response = await this.client.responses.create({ model: this.model, input: [{ role: 'user', content: prompt }], reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', name: 'harness_policy', strict: true, schema: proposalSchema } }, stream: false } as ResponseCreateParamsNonStreaming);
    return { proposal: ProposalSchema.parse(JSON.parse(response.output_text)), prompt, model: response.model };
  }
}

// Explicit development mode. The UI marks runs made with this adapter as simulated.
export class SimulatedAgents implements Agents {
  readonly model = 'simulated-agent';
  async runTask(policy: Policy, tools: AgentTools, trace: (tool: string, result: Record<string, unknown>) => Promise<void>, _memories: Episode[] = []): Promise<TaskOutcome> {
    const toolNames: string[] = [];
    for (const name of ['charge_customer', 'upgrade_customer'] as const) {
      const result = await tools[name](); toolNames.push(name); await trace(name, result);
    }
    let claim: Claim = 'success';
    if (policy.requireVerification) {
      let state = await tools.verify_entitlement(); toolNames.push('verify_entitlement'); await trace('verify_entitlement', state);
      if (!state.entitlementActive && policy.maxReconcileAttempts === 1) {
        const result = await tools.reconcile_entitlement(); toolNames.push('reconcile_entitlement'); await trace('reconcile_entitlement', result);
        state = await tools.verify_entitlement(); toolNames.push('verify_entitlement'); await trace('verify_entitlement', state);
      }
      if (!state.entitlementActive) claim = 'escalate';
    }
    return { claim, message: claim === 'success' ? 'Your upgrade is complete.' : 'The upgrade needs review.', prompt: `Simulated task agent, policy ${policy.version}`, model: this.model, toolNames };
  }
  async propose(_incident: string, _memories: Episode[], counterexamples: string[]): Promise<ProposalOutcome> {
    const recovery = counterexamples.length > 0;
    return { proposal: { requireVerification: true, maxReconcileAttempts: recovery ? 1 : 0, onFailure: 'escalate', explanation: recovery ? 'Verify actual entitlement, reconcile once after payment, verify again, and escalate if still inactive.' : 'Verify actual entitlement and escalate if access is still inactive.' }, prompt: 'Simulated policy proposal', model: this.model };
  }
}
