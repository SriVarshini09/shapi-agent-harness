import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import type { Payment } from './types.js';

export type PaymentProviderName = 'simulated' | 'stripe-test';

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  create(idempotencyKey: string): Promise<{ id: string; succeeded: boolean }>;
  verify(payment: Payment): Promise<boolean>;
}

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = 'simulated' as const;

  async create(): Promise<{ id: string; succeeded: boolean }> {
    return { id: randomUUID(), succeeded: true };
  }

  async verify(payment: Payment): Promise<boolean> {
    return payment.succeeded;
  }
}

export class StripeTestPaymentProvider implements PaymentProvider {
  readonly name = 'stripe-test' as const;
  private client: Pick<Stripe, 'paymentIntents'>;

  constructor(secretKey: string, client?: Pick<Stripe, 'paymentIntents'>) {
    if (!secretKey.startsWith('sk_test_')) throw new Error('Only a Stripe sk_test_ secret key is accepted; live charges are disabled');
    this.client = client ?? new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 15000 });
  }

  async create(idempotencyKey: string): Promise<{ id: string; succeeded: boolean }> {
    const intent = await this.client.paymentIntents.create({
      amount: 500,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      allowed_payment_method_types: ['card'],
      confirm: true,
      description: 'SHAPI harness demo - test payment only',
    }, { idempotencyKey });
    if (intent.livemode || intent.status !== 'succeeded') throw new Error(`Stripe test payment did not succeed: ${intent.status}`);
    return { id: intent.id, succeeded: true };
  }

  async verify(payment: Payment): Promise<boolean> {
    if (payment.provider !== this.name || !payment.id.startsWith('pi_')) return false;
    const intent = await this.client.paymentIntents.retrieve(payment.id);
    return !intent.livemode && intent.status === 'succeeded' && intent.amount === 500 && intent.currency === 'usd';
  }
}
