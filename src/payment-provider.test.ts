import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { StripeTestPaymentProvider } from './payment-provider.js';
import { makeTools, verifyReality } from './simulator.js';

function stripeFixture() {
  const intent = { id: 'pi_test_shapi', livemode: false, status: 'succeeded', amount: 500, currency: 'usd' };
  const create = vi.fn(async () => intent);
  const retrieve = vi.fn(async () => intent);
  const client = { paymentIntents: { create, retrieve } } as unknown as Pick<Stripe, 'paymentIntents'>;
  return { provider: new StripeTestPaymentProvider('sk_test_fixture', client), create, retrieve, intent };
}

describe('Stripe test payment integration', () => {
  it('refuses a live key before any API call', () => {
    expect(() => new StripeTestPaymentProvider('sk_live_do_not_use')).toThrow('Only a Stripe sk_test_');
  });

  it('creates exactly one test PaymentIntent across all harness versions and checks Stripe before reconciliation', async () => {
    const store = new MemoryStore();
    const session = await store.createSession();
    await store.setFault(session.id, 'silent');
    const { provider, create, retrieve } = stripeFixture();
    const tools = makeTools(store, session, provider);
    const first = await tools.charge_customer();
    expect(first).toMatchObject({ paymentId: 'pi_test_shapi', reused: false, provider: 'stripe-test', testMode: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ amount: 500, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: `${session.id}:maya:pro` });
    expect((await store.getPayment(session.id))?.provider).toBe('stripe-test');
    expect((await tools.upgrade_customer()).status).toBe(200);
    expect((await verifyReality(store, session, provider)).outcomeSucceeded).toBe(false);
    for (let version = 1; version <= 3; version++) expect((await tools.charge_customer()).reused).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls.length).toBeGreaterThan(3);
    await tools.reconcile_entitlement();
    expect(await tools.verify_entitlement()).toEqual({ paymentSucceeded: true, entitlementActive: true });
    expect((await verifyReality(store, session, provider)).outcomeSucceeded).toBe(true);
  });

  it('fails closed when Stripe no longer reports a succeeded test payment', async () => {
    const store = new MemoryStore();
    const session = await store.createSession();
    const { provider, retrieve, intent } = stripeFixture();
    const tools = makeTools(store, session, provider);
    await tools.charge_customer();
    retrieve.mockResolvedValueOnce({ ...intent, status: 'canceled' });
    await expect(tools.upgrade_customer()).rejects.toThrow('Payment must succeed');
    retrieve.mockResolvedValueOnce({ ...intent, livemode: true });
    await expect(tools.reconcile_entitlement()).rejects.toThrow('successful payment');
    expect((await store.getCustomer(session.customerId)).entitlementActive).toBe(false);
  });
});
