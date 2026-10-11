import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OpenAIAgents, SimulatedAgents } from './agents.js';
import { AtlasStore } from './atlas-store.js';
import { DemoCoordinator } from './demo.js';
import { MemoryStore } from './memory-store.js';
import { ensurePolicies } from './policies.js';
import { seedHistory } from './seed.js';
import { createRaindropObserver } from './raindrop.js';
import { SimulatedPaymentProvider, StripeTestPaymentProvider } from './payment-provider.js';

const config = z.object({
  MONGODB_URI: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
  PORT: z.coerce.number().int().positive().default(3007),
  DEMO_STORAGE: z.enum(['atlas', 'memory']).default('atlas'),
  RAINDROP_WRITE_KEY: z.string().optional(),
  RAINDROP_PROJECT_ID: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
}).parse(process.env);

if (config.DEMO_STORAGE === 'atlas' && (!config.MONGODB_URI || !config.OPENAI_API_KEY)) {
  throw new Error('Live mode requires MONGODB_URI and OPENAI_API_KEY. See .env.example.');
}
if (process.env.NODE_ENV === 'production' && config.DEMO_STORAGE !== 'atlas') {
  throw new Error('Production requires Atlas storage.');
}

const store = config.DEMO_STORAGE === 'atlas' ? new AtlasStore(config.MONGODB_URI!) : new MemoryStore();
await store.init();
await ensurePolicies(store);
if (store.mode === 'memory') await seedHistory(store);
const agents = config.OPENAI_API_KEY ? new OpenAIAgents(config.OPENAI_MODEL, config.OPENAI_API_KEY) : new SimulatedAgents();
const observer = config.RAINDROP_WRITE_KEY ? await createRaindropObserver(config.RAINDROP_WRITE_KEY, config.RAINDROP_PROJECT_ID) : undefined;
const paymentProvider = config.STRIPE_SECRET_KEY ? new StripeTestPaymentProvider(config.STRIPE_SECRET_KEY) : new SimulatedPaymentProvider();
const coordinator = new DemoCoordinator(store, agents, observer, paymentProvider);
const app = Fastify({ logger: true });

app.get('/api/ready', async () => {
  const readiness = await store.readiness();
  return { ...readiness, storage: store.mode, agents: agents instanceof SimulatedAgents ? 'simulated' : 'openai', model: agents.model, paymentProvider: paymentProvider.name, raindropConfigured: Boolean(observer), liveReady: store.mode === 'atlas' && !(agents instanceof SimulatedAgents) && readiness.memoryIndex };
});

app.post('/api/sessions', async (_request, reply) => reply.code(201).send(await store.createSession()));
app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
  const session = await store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: 'Session not found' });
  return { session, customer: await store.getCustomer(session.customerId), activeVersion: await store.getActiveVersion(session.id) };
});
app.post<{ Params: { id: string }; Body: { fault?: unknown } }>('/api/sessions/:id/fault', async (request, reply) => {
  const parsed = z.object({ fault: z.enum(['normal', 'silent']) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'fault must be normal or silent' });
  try { return await store.setFault(request.params.id, parsed.data.fault); }
  catch { return reply.code(404).send({ error: 'Session not found' }); }
});
app.post<{ Body: { sessionId?: unknown } }>('/api/demo/runs', async (request, reply) => {
  const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Valid sessionId required' });
  try { return reply.code(202).send({ runId: await coordinator.start(parsed.data.sessionId) }); }
  catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
  const run = await store.getRun(request.params.id);
  return run ?? reply.code(404).send({ error: 'Run not found' });
});
app.get<{ Params: { id: string } }>('/api/runs/:id/evidence', async (request, reply) => {
  try { return await coordinator.evidence(request.params.id); }
  catch { return reply.code(404).send({ error: 'Run not found' }); }
});
app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request, reply) => {
  const run = await store.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: 'Run not found' });
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of run.events) send(event);
  if (run.status !== 'running') { reply.raw.end(); return; }
  const unsubscribe = coordinator.subscribe(run.id, event => {
    send(event);
    if (event.kind === 'verified-success' || event.kind === 'escalated' || event.kind === 'error') reply.raw.end();
  });
  const keepAlive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
  reply.raw.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
});

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const webDist = join(projectRoot, 'web-dist');
await app.register(fastifyStatic, { root: webDist });
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/assets/')) return reply.code(404).send({ error: 'Not found' });
  return reply.sendFile('index.html');
});

const shutdown = async () => { await app.close(); await observer?.close(); await store.close(); };
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ port: config.PORT, host: '0.0.0.0' });
