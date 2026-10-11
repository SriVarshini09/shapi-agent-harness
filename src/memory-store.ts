import { randomUUID } from 'node:crypto';
import { initialPolicies } from './policies.js';
import type { Customer, DemoRun, DemoSession, Episode, EvalRun, Fault, Payment, Policy, RunEvent, Store, Version } from './types.js';

export class MemoryStore implements Store {
  readonly mode = 'memory' as const;
  private sessions = new Map<string, DemoSession>();
  private customers = new Map<string, Customer>();
  private payments = new Map<string, Payment>();
  private runs = new Map<string, DemoRun>();
  private episodes: Episode[] = [];
  private policies = new Map<string, Policy>(initialPolicies.map(p => [p.id, { ...p }]));
  private evals: EvalRun[] = [];
  private active = new Map<string, Version>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async createSession(): Promise<DemoSession> {
    const id = randomUUID();
    const session: DemoSession = { id, customerId: `maya-${id}`, fault: 'normal', createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    this.active.set(id, 'v2');
    this.customers.set(session.customerId, { id: session.customerId, sessionId: id, name: 'Maya', entitlementActive: false });
    return session;
  }
  async getSession(id: string): Promise<DemoSession | null> { return this.sessions.get(id) ?? null; }
  async setFault(id: string, fault: Fault): Promise<DemoSession> {
    const session = this.sessions.get(id); if (!session) throw new Error('Session not found');
    session.fault = fault; return session;
  }
  async getCustomer(id: string): Promise<Customer> {
    const customer = this.customers.get(id); if (!customer) throw new Error('Customer not found');
    return { ...customer };
  }
  async setEntitlement(id: string, active: boolean): Promise<void> {
    const customer = this.customers.get(id); if (!customer) throw new Error('Customer not found');
    customer.entitlementActive = active;
  }
  async getPayment(sessionId: string): Promise<Payment | null> { return this.payments.get(sessionId) ?? null; }
  async createPayment(payment: Payment): Promise<Payment> {
    const existing = this.payments.get(payment.sessionId);
    if (existing) return existing;
    this.payments.set(payment.sessionId, payment); return payment;
  }
  async createRun(run: DemoRun): Promise<void> { this.runs.set(run.id, run); }
  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const run = this.runs.get(runId); if (!run) throw new Error('Run not found'); run.events.push(event);
  }
  async finishRun(runId: string, changes: Partial<DemoRun>): Promise<void> {
    const run = this.runs.get(runId); if (!run) throw new Error('Run not found'); Object.assign(run, changes);
  }
  async getRun(runId: string): Promise<DemoRun | null> { return this.runs.get(runId) ?? null; }
  async saveEpisode(episode: Episode): Promise<void> { this.episodes.push(episode); }
  async searchEpisodes(summary: string, limit: number): Promise<Episode[]> {
    const query = new Set(summary.toLowerCase().split(/\W+/).filter(word => word.length > 3));
    return this.episodes.map(episode => ({ ...episode, score: [...query].filter(word => episode.summary.toLowerCase().includes(word)).length / Math.max(query.size, 1) }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
  async listEpisodes(runId: string): Promise<Episode[]> { return this.episodes.filter(e => e.runId === runId); }
  async savePolicy(policy: Policy): Promise<void> { this.policies.set(policy.id, policy); }
  async updatePolicy(id: string, status: Policy['status']): Promise<void> {
    const policy = this.policies.get(id); if (!policy) throw new Error('Policy not found'); policy.status = status;
  }
  async listPolicies(): Promise<Policy[]> { return [...this.policies.values()]; }
  async getActiveVersion(sessionId: string): Promise<Version> { return this.active.get(sessionId) ?? 'v2'; }
  async promotePolicy(sessionId: string, expected: Version, policyId: string): Promise<boolean> {
    const candidate = this.policies.get(policyId);
    const passingEval = this.evals.find(item => item.policyId === policyId && item.passed);
    if (this.active.get(sessionId) !== expected || candidate?.status !== 'candidate' || !passingEval || passingEval.results.length !== 18 || passingEval.results.some(result => !result.passed || result.falseSuccess || result.chargeCount !== 1)) return false;
    this.active.set(sessionId, 'v3'); return true;
  }
  async saveEval(evaluation: EvalRun): Promise<void> { this.evals.push(evaluation); }
  async listEvals(runId: string): Promise<EvalRun[]> { return this.evals.filter(e => e.runId === runId); }
  async readiness(): Promise<{ database: boolean; memoryIndex: boolean }> { return { database: true, memoryIndex: true }; }
}
