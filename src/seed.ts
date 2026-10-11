import { randomUUID } from 'node:crypto';
import { makeTools, verifyReality } from './simulator.js';
import type { Episode, Store } from './types.js';

const histories = [
  'Prior simulated run: upgrade API returned 200 OK after successful payment. Entitlement was missing until a reconciliation call granted access.',
  'Prior simulated run: webhook was acknowledged with 200 OK, but provisioning silently skipped customer access after payment.',
  'Prior simulated run: payment succeeded and upgrade request was accepted, yet an independent customer state check showed Pro access locked.',
];

export async function seedHistory(store: Store): Promise<number> {
  const existing = await store.listEpisodes('seed-1');
  if (existing.length) return 0;
  for (let i = 0; i < histories.length; i++) {
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const tools = makeTools(store, { ...session, fault: 'silent' });
    await tools.charge_customer();
    await tools.upgrade_customer();
    const reality = await verifyReality(store, session);
    const episode: Episode = {
      id: randomUUID(), sessionId: session.id, runId: `seed-${i + 1}`, source: 'simulated-seed', version: 'v0',
      summary: histories[i], claim: 'success', paymentSucceeded: reality.paymentSucceeded,
      entitlementActive: reality.customer.entitlementActive, createdAt: new Date().toISOString(),
    };
    await store.saveEpisode(episode);
  }
  return histories.length;
}
