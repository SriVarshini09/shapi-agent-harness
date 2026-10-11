import 'dotenv/config';
import { AtlasStore } from './atlas-store.js';
import { ensurePolicies } from './policies.js';
import { seedHistory } from './seed.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required. Put it in a local .env file; never commit it.');
const store = new AtlasStore(uri);
try {
  await store.init();
  await ensurePolicies(store);
  const seeded = await seedHistory(store);
  await store.setupMemoryIndex();
  const ready = await store.readiness();
  console.log(`Atlas database ready; seeded ${seeded} prior simulated episodes; memory index ${ready.memoryIndex ? 'queryable' : 'building'}.`);
  if (!ready.memoryIndex) console.log('Run pnpm setup:atlas again after the index finishes building.');
} finally {
  await store.close();
}
