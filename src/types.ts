export type Fault = 'normal' | 'silent';
export type Version = 'v0' | 'v1' | 'v2' | 'v3';
export type Claim = 'success' | 'escalate';

export interface Customer {
  id: string;
  sessionId: string;
  name: string;
  entitlementActive: boolean;
}

export interface DemoSession {
  id: string;
  fault: Fault;
  customerId: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  provider?: 'simulated' | 'stripe-test';
  sessionId: string;
  customerId: string;
  idempotencyKey: string;
  succeeded: boolean;
  createdAt: string;
}

export interface Policy {
  id: string;
  version: Version;
  parentVersion: Version | null;
  requireVerification: boolean;
  useMemory: boolean;
  maxReconcileAttempts: 0 | 1;
  onFailure: 'escalate';
  explanation: string;
  status: 'engineered' | 'candidate' | 'rejected' | 'promoted';
  sourceRunId?: string;
  model?: string;
  prompt?: string;
  createdAt: string;
}

export interface RunEvent {
  seq: number;
  at: string;
  phase: 'setup' | 'baseline' | 'v1' | 'v2' | 'verify' | 'memory' | 'propose' | 'eval' | 'promote' | 'improved' | 'system';
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface DemoRun {
  id: string;
  sessionId: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  events: RunEvent[];
  baselineClaim?: Claim;
  baselineVerified?: boolean;
  improvedClaim?: Claim;
  improvedVerified?: boolean;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Episode {
  id: string;
  sessionId: string;
  runId: string;
  source: 'simulated-seed' | 'live';
  version: Version;
  summary: string;
  claim: Claim;
  paymentSucceeded: boolean;
  entitlementActive: boolean;
  createdAt: string;
  score?: number;
}

export interface CaseResult {
  id: string;
  category: string;
  passed: boolean;
  claim: Claim;
  entitlementActive: boolean;
  chargeCount: number;
  falseSuccess: boolean;
  toolCalls: string[];
  detail: string;
}

export interface EvalRun {
  id: string;
  runId: string;
  policyId: string;
  version: Version;
  passed: boolean;
  results: CaseResult[];
  createdAt: string;
}

export interface Evidence {
  run: DemoRun;
  customer: Customer;
  payment: Payment | null;
  episodes: Episode[];
  policies: Policy[];
  evals: EvalRun[];
  activeVersion: Version;
}

export interface Store {
  mode: 'atlas' | 'memory';
  init(): Promise<void>;
  close(): Promise<void>;
  createSession(): Promise<DemoSession>;
  getSession(id: string): Promise<DemoSession | null>;
  setFault(id: string, fault: Fault): Promise<DemoSession>;
  getCustomer(id: string): Promise<Customer>;
  setEntitlement(id: string, active: boolean): Promise<void>;
  getPayment(sessionId: string): Promise<Payment | null>;
  createPayment(payment: Payment): Promise<Payment>;
  createRun(run: DemoRun): Promise<void>;
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  finishRun(runId: string, changes: Partial<DemoRun>): Promise<void>;
  getRun(runId: string): Promise<DemoRun | null>;
  saveEpisode(episode: Episode): Promise<void>;
  searchEpisodes(summary: string, limit: number): Promise<Episode[]>;
  listEpisodes(runId: string): Promise<Episode[]>;
  savePolicy(policy: Policy): Promise<void>;
  updatePolicy(id: string, status: Policy['status']): Promise<void>;
  listPolicies(): Promise<Policy[]>;
  getActiveVersion(sessionId: string): Promise<Version>;
  promotePolicy(sessionId: string, expected: Version, policyId: string): Promise<boolean>;
  saveEval(evaluation: EvalRun): Promise<void>;
  listEvals(runId: string): Promise<EvalRun[]>;
  readiness(): Promise<{ database: boolean; memoryIndex: boolean }>;
}
