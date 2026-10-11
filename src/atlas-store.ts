import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import type { Customer, DemoRun, DemoSession, Episode, EvalRun, Fault, Payment, Policy, RunEvent, Store, Version } from './types.js';

const INDEX_NAME = 'episode_memory_voyage4';

export class AtlasStore implements Store {
  readonly mode = 'atlas' as const;
  private client: MongoClient;
  private db!: Db;
  constructor(uri: string) { this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 }); }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db('shapi_harness');
    await this.db.command({ ping: 1 });
    await Promise.all([
      this.db.collection('payments').createIndex({ idempotencyKey: 1 }, { unique: true }),
      this.db.collection('runs').createIndex({ sessionId: 1, createdAt: -1 }),
      this.db.collection('episodes').createIndex({ runId: 1 }),
      this.db.collection('eval_runs').createIndex({ runId: 1 }),
    ]);
  }
  async close(): Promise<void> { await this.client.close(); }
  async createSession(): Promise<DemoSession> {
    const id = randomUUID();
    const session: DemoSession = { id, customerId: `maya-${id}`, fault: 'normal', createdAt: new Date().toISOString() };
    const customer: Customer = { id: session.customerId, sessionId: id, name: 'Maya', entitlementActive: false };
    await this.db.collection('demo_sessions').insertOne(session);
    await this.db.collection('customers').insertOne(customer);
    await this.db.collection('policies').insertOne({ id: `active:${id}`, version: 'v2' });
    return session;
  }
  async getSession(id: string): Promise<DemoSession | null> {
    return this.db.collection<DemoSession>('demo_sessions').findOne({ id }, { projection: { _id: 0 } });
  }
  async setFault(id: string, fault: Fault): Promise<DemoSession> {
    const result = await this.db.collection<DemoSession>('demo_sessions').findOneAndUpdate({ id }, { $set: { fault } }, { returnDocument: 'after', projection: { _id: 0 } });
    if (!result) throw new Error('Session not found'); return result;
  }
  async getCustomer(id: string): Promise<Customer> {
    const customer = await this.db.collection<Customer>('customers').findOne({ id }, { projection: { _id: 0 } });
    if (!customer) throw new Error('Customer not found'); return customer;
  }
  async setEntitlement(id: string, active: boolean): Promise<void> {
    const result = await this.db.collection('customers').updateOne({ id }, { $set: { entitlementActive: active } });
    if (!result.matchedCount) throw new Error('Customer not found');
  }
  async getPayment(sessionId: string): Promise<Payment | null> {
    return this.db.collection<Payment>('payments').findOne({ sessionId }, { projection: { _id: 0 } });
  }
  async createPayment(payment: Payment): Promise<Payment> {
    await this.db.collection('payments').updateOne({ idempotencyKey: payment.idempotencyKey }, { $setOnInsert: payment }, { upsert: true });
    const saved = await this.db.collection<Payment>('payments').findOne({ idempotencyKey: payment.idempotencyKey }, { projection: { _id: 0 } });
    if (!saved) throw new Error('Payment write failed'); return saved;
  }
  async createRun(run: DemoRun): Promise<void> { await this.db.collection('runs').insertOne(run); }
  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    await this.db.collection<DemoRun>('runs').updateOne({ id: runId }, { $push: { events: event } });
  }
  async finishRun(runId: string, changes: Partial<DemoRun>): Promise<void> {
    await this.db.collection('runs').updateOne({ id: runId }, { $set: changes });
  }
  async getRun(runId: string): Promise<DemoRun | null> {
    return this.db.collection<DemoRun>('runs').findOne({ id: runId }, { projection: { _id: 0 } });
  }
  async saveEpisode(episode: Episode): Promise<void> { await this.db.collection('episodes').insertOne(episode); }
  async searchEpisodes(summary: string, limit: number): Promise<Episode[]> {
    return this.db.collection('episodes').aggregate<Episode>([
      { $vectorSearch: { index: INDEX_NAME, path: 'summary', query: { text: summary }, numCandidates: 30, limit } },
      { $project: { _id: 0, id: 1, sessionId: 1, runId: 1, source: 1, version: 1, summary: 1, claim: 1, paymentSucceeded: 1, entitlementActive: 1, createdAt: 1, score: { $meta: 'vectorSearchScore' } } },
    ]).toArray();
  }
  async listEpisodes(runId: string): Promise<Episode[]> {
    return this.db.collection<Episode>('episodes').find({ runId }, { projection: { _id: 0 } }).toArray();
  }
  async savePolicy(policy: Policy): Promise<void> {
    await this.db.collection('policies').updateOne({ id: policy.id }, { $setOnInsert: policy }, { upsert: true });
  }
  async updatePolicy(id: string, status: Policy['status']): Promise<void> {
    await this.db.collection('policies').updateOne({ id }, { $set: { status } });
  }
  async listPolicies(): Promise<Policy[]> {
    return this.db.collection<Policy>('policies').find({ id: { $not: /^active:/ } }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  }
  async getActiveVersion(sessionId: string): Promise<Version> {
    const doc = await this.db.collection<{ id: string; version: Version }>('policies').findOne({ id: `active:${sessionId}` });
    return doc?.version ?? 'v2';
  }
  async promotePolicy(sessionId: string, expected: Version, policyId: string): Promise<boolean> {
    const candidate = await this.db.collection<Policy>('policies').findOne({ id: policyId, version: 'v3', status: 'candidate' });
    if (!candidate) return false;
    const passingEval = await this.db.collection<EvalRun>('eval_runs').findOne({ policyId, passed: true });
    if (!passingEval || passingEval.results.length !== 18 || passingEval.results.some(result => !result.passed || result.falseSuccess || result.chargeCount !== 1)) return false;
    const result = await this.db.collection('policies').updateOne({ id: `active:${sessionId}`, version: expected }, { $set: { version: 'v3', policyId, promotedAt: new Date().toISOString() } });
    return result.modifiedCount === 1;
  }
  async saveEval(evaluation: EvalRun): Promise<void> { await this.db.collection('eval_runs').insertOne(evaluation); }
  async listEvals(runId: string): Promise<EvalRun[]> {
    return this.db.collection<EvalRun>('eval_runs').find({ runId }, { projection: { _id: 0 } }).toArray();
  }
  async readiness(): Promise<{ database: boolean; memoryIndex: boolean }> {
    await this.db.command({ ping: 1 });
    const marker = new Date().toISOString();
    await this.db.collection('readiness').updateOne({ id: 'read-write-canary' }, { $set: { marker } }, { upsert: true });
    const observed = await this.db.collection<{ id: string; marker: string }>('readiness').findOne({ id: 'read-write-canary' });
    if (observed?.marker !== marker) throw new Error('Atlas read/write readiness check failed');
    const indexes = await this.db.collection('episodes').listSearchIndexes().toArray() as { name: string; queryable?: boolean }[];
    return { database: true, memoryIndex: indexes.some(index => index.name === INDEX_NAME && index.queryable === true) };
  }
  async setupMemoryIndex(): Promise<void> {
    const indexes = await this.db.collection('episodes').listSearchIndexes().toArray();
    if (indexes.some(index => index.name === INDEX_NAME)) return;
    await this.db.collection('episodes').createSearchIndex({
      name: INDEX_NAME, type: 'vectorSearch',
      definition: { fields: [{ type: 'autoEmbed', modality: 'text', path: 'summary', model: 'voyage-4' }] },
    });
  }
}
