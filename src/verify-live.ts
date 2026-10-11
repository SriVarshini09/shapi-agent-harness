import 'dotenv/config';
import OpenAI from 'openai';
import { z } from 'zod';
import { AtlasStore } from './atlas-store.js';

const config = z.object({
  MONGODB_URI: z.string().min(1, 'Set MONGODB_URI in .env'),
  OPENAI_API_KEY: z.string().min(1, 'Set OPENAI_API_KEY in .env'),
  OPENAI_MODEL: z.string().default('gpt-6-luna'),
}).parse(process.env);

const store = new AtlasStore(config.MONGODB_URI);
try {
  await store.init();
  const ready = await store.readiness();
  if (!ready.database) throw new Error('Atlas read/write check failed');
  if (!ready.memoryIndex) throw new Error('Atlas memory index is not queryable; run pnpm setup:atlas and retry after index build');

  const memories = await store.searchEpisodes('Payment succeeded but Pro entitlement remained inactive after upgrade 200 OK', 3);
  if (!memories.some(memory => memory.source === 'simulated-seed')) {
    throw new Error('Atlas Vector Search did not retrieve a seeded episode');
  }

  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 30000, maxRetries: 0 });
  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
    input: 'Return the requested JSON to confirm live API access.',
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_schema', name: 'live_preflight', strict: true,
      schema: { type: 'object', additionalProperties: false, properties: { ready: { type: 'boolean', enum: [true] } }, required: ['ready'] },
    } },
  });
  const result = z.object({ ready: z.literal(true) }).parse(JSON.parse(response.output_text));
  if (!result.ready) throw new Error('OpenAI structured output check failed');

  console.log(JSON.stringify({ liveReady: true, atlasReadWrite: true, atlasVectorSearch: true,
    seededMemoriesRetrieved: memories.filter(memory => memory.source === 'simulated-seed').length,
    openaiResponses: true, model: response.model }, null, 2));
} finally {
  await store.close();
}
