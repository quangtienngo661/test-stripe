import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

export interface InvoiceLineSummary {
  id: string;
  description: string | null;
  amount: number;
  quantity: number | null;
  proration: boolean;
  periodStart: number;
  periodEnd: number;
  priceId: string | null;
  unitAmount: number | null;
}

export interface InvoiceSummary {
  id: string | null;
  number: string | null;
  status: string | null;
  billingReason: string | null;
  currency: string;
  subtotal: number;
  total: number;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  startingBalance: number;
  endingBalance: number | null;
  periodStart: number;
  periodEnd: number;
  created: number;
  dueDate: number | null;
  nextPaymentAttempt: number | null;
  hostedInvoiceUrl?: string | null;
  lines: InvoiceLineSummary[];
  prorationTotal: number;
  recurringTotal: number;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private cached: Stripe | null = null;

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    const key = this.config.get<string>('stripeSecretKey') ?? '';
    // treat the .env.example placeholder as "not configured"
    return key.startsWith('sk_') && !key.endsWith('xxx');
  }

  get publishableKey(): string {
    return this.config.get<string>('stripePublishableKey') ?? '';
  }

  get webhookSecret(): string {
    const secret = this.config.get<string>('stripeWebhookSecret') ?? '';
    // the .env.example placeholder means "no webhook configured yet"
    return secret.startsWith('whsec_') && !secret.endsWith('xxx') ? secret : '';
  }

  get currency(): string {
    return this.config.get<string>('currency') ?? 'usd';
  }

  get client(): Stripe {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'STRIPE_SECRET_KEY is not set. Copy backend/.env.example to backend/.env and add your Stripe test key.',
      );
    }
    if (!this.cached) {
      this.cached = new Stripe(this.config.get<string>('stripeSecretKey')!, {
        appInfo: { name: 'OptiSigns Billing Demo', version: '1.0.0' },
        // Stripe retries these safely (idempotency keys are added automatically
        // for writes), which turns a transient timeout into a slow call instead
        // of a failed one.
        maxNetworkRetries: 3,
        timeout: 40000,
      });
      this.logger.log(`Stripe client ready (API ${Stripe.API_VERSION ?? 'sdk default'})`);
    }
    return this.cached;
  }

  /**
   * Stripe removed `current_period_end` from the Subscription object; each
   * subscription item now carries its own period. For a single-cycle
   * subscription every item shares the same window.
   */
  static periodEnd(sub: Stripe.Subscription): number | null {
    const item = sub.items?.data?.[0];
    return item?.current_period_end ?? null;
  }

  static periodStart(sub: Stripe.Subscription): number | null {
    const item = sub.items?.data?.[0];
    return item?.current_period_start ?? null;
  }

  static isProration(line: Stripe.InvoiceLineItem): boolean {
    return Boolean(line.parent?.subscription_item_details?.proration);
  }

  static linePriceId(line: Stripe.InvoiceLineItem): string | null {
    return (line.pricing?.price_details as any)?.price ?? null;
  }

  summarizeInvoice(invoice: Stripe.Invoice): InvoiceSummary {
    const lines: InvoiceLineSummary[] = (invoice.lines?.data ?? []).map((line) => ({
      id: line.id,
      description: line.description,
      amount: line.amount,
      quantity: line.quantity,
      proration: StripeService.isProration(line),
      periodStart: line.period?.start,
      periodEnd: line.period?.end,
      priceId: StripeService.linePriceId(line),
      unitAmount: line.pricing?.unit_amount_decimal ? Number(line.pricing.unit_amount_decimal) : null,
    }));

    return {
      id: invoice.id ?? null,
      number: invoice.number ?? null,
      status: invoice.status ?? null,
      billingReason: invoice.billing_reason ?? null,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      total: invoice.total,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      amountRemaining: invoice.amount_remaining,
      startingBalance: invoice.starting_balance,
      endingBalance: invoice.ending_balance ?? null,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      created: invoice.created,
      dueDate: invoice.due_date ?? null,
      nextPaymentAttempt: invoice.next_payment_attempt ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      lines,
      prorationTotal: lines.filter((l) => l.proration).reduce((sum, l) => sum + l.amount, 0),
      recurringTotal: lines.filter((l) => !l.proration).reduce((sum, l) => sum + l.amount, 0),
    };
  }

  /**
   * "Now" as the customer experiences it.
   *
   * Accounts bound to a test clock live in simulated time. Using wall-clock
   * time for them silently corrupts anything time-based: proration would be
   * computed from the wrong instant, refund windows would never expire and
   * schedule phases would be misjudged as future.
   */
  async nowFor(testClockId?: string | null): Promise<number> {
    if (!testClockId) return Math.floor(Date.now() / 1000);
    try {
      const clock = await this.client.testHelpers.testClocks.retrieve(testClockId);
      return clock.frozen_time;
    } catch (err: any) {
      this.logger.warn(`Could not read test clock ${testClockId}: ${err.message}`);
      return Math.floor(Date.now() / 1000);
    }
  }

  /** Resolves the PaymentIntent (or charge) backing a paid invoice, for refunds. */
  async findInvoicePayment(invoiceId: string): Promise<{ paymentIntent?: string; charge?: string }> {
    const invoice = await this.client.invoices.retrieve(invoiceId, { expand: ['payments'] });
    for (const payment of invoice.payments?.data ?? []) {
      const pi = payment.payment?.payment_intent;
      const charge = payment.payment?.charge;
      if (pi) return { paymentIntent: typeof pi === 'string' ? pi : pi.id };
      if (charge) return { charge: typeof charge === 'string' ? charge : charge.id };
    }
    return {};
  }

  /** Turns a Stripe error into a readable HTTP error instead of a 500. */
  async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      const message = err?.raw?.message ?? err?.message ?? 'Unknown Stripe error';
      this.logger.error(`${label} failed: ${message}`);
      throw new BadRequestException({
        message: `Stripe (${label}): ${message}`,
        stripeCode: err?.raw?.code ?? err?.code,
        stripeType: err?.raw?.type ?? err?.type,
        docUrl: err?.raw?.doc_url,
        param: err?.raw?.param,
      });
    }
  }
}
