import type { Customer, DemoSession, Payment, Store } from './types.js';
import { SimulatedPaymentProvider, type PaymentProvider } from './payment-provider.js';

const simulatedPayment = new SimulatedPaymentProvider();

async function paymentSucceeded(store: Store, session: DemoSession, provider: PaymentProvider): Promise<boolean> {
  const payment = await store.getPayment(session.id);
  if (!payment || (payment.provider ?? 'simulated') !== provider.name) return false;
  return provider.verify(payment);
}

export function makeTools(store: Store, session: DemoSession, provider: PaymentProvider = simulatedPayment) {
  return {
    async charge_customer(): Promise<{ status: 200; paymentId: string; reused: boolean; provider: string; testMode: boolean }> {
      const existing = await store.getPayment(session.id);
      if (existing && (existing.provider ?? 'simulated') !== provider.name) throw new Error('Payment provider changed for this session; reset the demo');
      const idempotencyKey = `${session.id}:maya:pro`;
      const created = existing ?? await provider.create(idempotencyKey);
      const payment: Payment = existing ?? {
        id: created.id, provider: provider.name, sessionId: session.id, customerId: session.customerId,
        idempotencyKey, succeeded: created.succeeded, createdAt: new Date().toISOString(),
      };
      const saved = existing ?? await store.createPayment(payment);
      if (saved.id !== payment.id || (saved.provider ?? 'simulated') !== provider.name) throw new Error('Payment idempotency conflict');
      if (!(await provider.verify(saved))) throw new Error('Payment could not be verified with provider');
      return { status: 200, paymentId: saved.id, reused: Boolean(existing), provider: provider.name, testMode: provider.name === 'stripe-test' };
    },
    async upgrade_customer(): Promise<{ status: 200; message: string }> {
      if (!(await paymentSucceeded(store, session, provider))) throw new Error('Payment must succeed before upgrade');
      if (session.fault === 'normal') await store.setEntitlement(session.customerId, true);
      return { status: 200, message: 'Upgrade request accepted' };
    },
    async verify_entitlement(): Promise<{ paymentSucceeded: boolean; entitlementActive: boolean }> {
      const [customer, succeeded] = await Promise.all([store.getCustomer(session.customerId), paymentSucceeded(store, session, provider)]);
      return { paymentSucceeded: succeeded, entitlementActive: customer.entitlementActive };
    },
    async reconcile_entitlement(): Promise<{ status: 200; entitlementActive: boolean }> {
      if (!(await paymentSucceeded(store, session, provider))) throw new Error('Cannot reconcile without a successful payment');
      await store.setEntitlement(session.customerId, true);
      return { status: 200, entitlementActive: true };
    },
  };
}

export async function verifyReality(store: Store, session: DemoSession, provider: PaymentProvider = simulatedPayment): Promise<{ customer: Customer; paymentSucceeded: boolean; outcomeSucceeded: boolean }> {
  const [customer, succeeded] = await Promise.all([store.getCustomer(session.customerId), paymentSucceeded(store, session, provider)]);
  return { customer, paymentSucceeded: succeeded, outcomeSucceeded: succeeded && customer.entitlementActive };
}
