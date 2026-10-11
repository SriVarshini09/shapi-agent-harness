import { randomUUID } from 'node:crypto';
import type { Customer, DemoSession, Payment, Store } from './types.js';

export function makeTools(store: Store, session: DemoSession) {
  return {
    async charge_customer(): Promise<{ status: 200; paymentId: string; reused: boolean }> {
      const existing = await store.getPayment(session.id);
      const payment: Payment = existing ?? {
        id: randomUUID(), sessionId: session.id, customerId: session.customerId,
        idempotencyKey: `${session.id}:maya:pro`, succeeded: true, createdAt: new Date().toISOString(),
      };
      const saved = await store.createPayment(payment);
      return { status: 200, paymentId: saved.id, reused: Boolean(existing) };
    },
    async upgrade_customer(): Promise<{ status: 200; message: string }> {
      const payment = await store.getPayment(session.id);
      if (!payment?.succeeded) throw new Error('Payment must succeed before upgrade');
      if (session.fault === 'normal') await store.setEntitlement(session.customerId, true);
      return { status: 200, message: 'Upgrade request accepted' };
    },
    async verify_entitlement(): Promise<{ paymentSucceeded: boolean; entitlementActive: boolean }> {
      const [customer, payment] = await Promise.all([store.getCustomer(session.customerId), store.getPayment(session.id)]);
      return { paymentSucceeded: Boolean(payment?.succeeded), entitlementActive: customer.entitlementActive };
    },
    async reconcile_entitlement(): Promise<{ status: 200; entitlementActive: boolean }> {
      const payment = await store.getPayment(session.id);
      if (!payment?.succeeded) throw new Error('Cannot reconcile without a successful payment');
      await store.setEntitlement(session.customerId, true);
      return { status: 200, entitlementActive: true };
    },
  };
}

export async function verifyReality(store: Store, session: DemoSession): Promise<{ customer: Customer; paymentSucceeded: boolean; outcomeSucceeded: boolean }> {
  const [customer, payment] = await Promise.all([store.getCustomer(session.customerId), store.getPayment(session.id)]);
  return { customer, paymentSucceeded: Boolean(payment?.succeeded), outcomeSucceeded: Boolean(payment?.succeeded && customer.entitlementActive) };
}
