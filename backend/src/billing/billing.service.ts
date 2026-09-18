import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeService } from '../stripe/stripe.service';
import { PolicyService } from '../policy/policy.service';
import { AccountsService } from '../accounts/accounts.service';
import { EventsService } from '../events/events.service';
import { CatalogService } from '../catalog/catalog.service';
import { AccountDocument } from '../accounts/account.schema';

export interface RefundRequest {
  invoiceId: string;
  amountCents?: number;
  reason?: Stripe.CreditNoteCreateParams.Reason;
  mode?: 'credit_note' | 'refund';
  /** bypass the policy window / auto-approve ceiling */
  force?: boolean;
  memo?: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly policy: PolicyService,
    private readonly accounts: AccountsService,
    private readonly events: EventsService,
    private readonly catalog: CatalogService,
  ) {}

  // ---------------------------------------------------------------- invoices

  async listInvoices(accountId: string, limit = 25) {
    const account = await this.accounts.get(accountId);
    const invoices = await this.stripe.call('invoices.list', () =>
      this.stripe.client.invoices.list({ customer: account.stripeCustomerId!, limit }),
    );
    return invoices.data.map((invoice) => this.stripe.summarizeInvoice(invoice));
  }

  async getInvoice(invoiceId: string) {
    const invoice = await this.stripe.call('invoices.retrieve', () =>
      this.stripe.client.invoices.retrieve(invoiceId, { expand: ['payments'] }),
    );
    return { summary: this.stripe.summarizeInvoice(invoice), raw: invoice };
  }

  /** Retry collection on an open / past_due invoice. */
  async payInvoice(invoiceId: string) {
    const invoice = await this.stripe.call('invoices.pay', () =>
      this.stripe.client.invoices.pay(invoiceId),
    );
    await this.recordInvoiceEvent(invoice, 'invoice.paid_manually', 'Collection retried from the demo UI');
    return this.stripe.summarizeInvoice(invoice);
  }

  async finalizeInvoice(invoiceId: string) {
    const invoice = await this.stripe.call('invoices.finalizeInvoice', () =>
      this.stripe.client.invoices.finalizeInvoice(invoiceId),
    );
    await this.recordInvoiceEvent(invoice, 'invoice.finalized', 'Draft invoice finalised');
    return this.stripe.summarizeInvoice(invoice);
  }

  async voidInvoice(invoiceId: string) {
    const invoice = await this.stripe.call('invoices.voidInvoice', () =>
      this.stripe.client.invoices.voidInvoice(invoiceId),
    );
    await this.recordInvoiceEvent(invoice, 'invoice.voided', 'Invoice voided');
    return this.stripe.summarizeInvoice(invoice);
  }

  async markUncollectible(invoiceId: string) {
    const invoice = await this.stripe.call('invoices.markUncollectible', () =>
      this.stripe.client.invoices.markUncollectible(invoiceId),
    );
    await this.recordInvoiceEvent(invoice, 'invoice.uncollectible', 'Invoice written off');
    return this.stripe.summarizeInvoice(invoice);
  }

  // ------------------------------------------------------- refunds / credits

  /**
   * Refunds or credits an invoice under the current refund policy.
   *
   * mode=credit_note  -> Stripe issues a credit note against the invoice. With
   *                      `refund_amount` the money also goes back to the card;
   *                      without it the customer just gets account credit.
   * mode=refund       -> a plain PaymentIntent refund, the invoice is untouched.
   */
  /**
   * What is genuinely left to refund on an invoice.
   *
   * `amount_paid` minus credit notes is not enough: a plain PaymentIntent
   * refund does not touch either number, so refunding twice would look legal
   * here and then fail (or over-refund) at Stripe. The charge is the only place
   * that knows the true refunded total.
   */
  private async refundableAmount(invoice: Stripe.Invoice): Promise<number> {
    const paidMinusCreditNotes = invoice.amount_paid - (invoice.post_payment_credit_notes_amount ?? 0);
    const payment = await this.stripe.findInvoicePayment(invoice.id!);
    let alreadyRefunded = 0;
    try {
      if (payment.paymentIntent) {
        const pi = await this.stripe.client.paymentIntents.retrieve(payment.paymentIntent, {
          expand: ['latest_charge'],
        });
        const charge = pi.latest_charge;
        if (charge && typeof charge !== 'string') alreadyRefunded = charge.amount_refunded ?? 0;
      } else if (payment.charge) {
        const charge = await this.stripe.client.charges.retrieve(payment.charge);
        alreadyRefunded = charge.amount_refunded ?? 0;
      }
    } catch (err: any) {
      this.logger.warn(`Could not read refunded total for ${invoice.id}: ${err.message}`);
    }
    return Math.max(0, Math.min(paidMinusCreditNotes, invoice.amount_paid - alreadyRefunded));
  }

  async refundInvoice(accountId: string, req: RefundRequest) {
    const account = await this.accounts.get(accountId);
    const policy = await this.policy.get();
    const invoice = await this.stripe.call('invoices.retrieve', () =>
      this.stripe.client.invoices.retrieve(req.invoiceId, { expand: ['payments'] }),
    );

    if (invoice.status !== 'paid') {
      throw new BadRequestException(`Invoice ${invoice.number ?? invoice.id} is ${invoice.status}, only paid invoices can be refunded`);
    }

    const refundable = await this.refundableAmount(invoice);
    const amount = req.amountCents ?? refundable;

    if (refundable <= 0) throw new BadRequestException('This invoice has already been fully refunded');
    if (amount <= 0) throw new BadRequestException('Nothing left to refund on this invoice');
    if (amount > refundable) {
      throw new BadRequestException(`Only ${refundable / 100} ${invoice.currency.toUpperCase()} is still refundable on this invoice`);
    }

    const ageDays = ((await this.stripe.nowFor(account.testClockId)) - invoice.created) / 86400;
    if (!req.force && ageDays > policy.refunds.windowDays) {
      throw new BadRequestException(
        `Invoice is ${Math.floor(ageDays)} days old and the refund window is ${policy.refunds.windowDays} days. Send force=true to override.`,
      );
    }
    if (!req.force && !policy.refunds.allowPartial && amount !== refundable) {
      throw new BadRequestException('The current policy does not allow partial refunds');
    }
    if (!req.force && amount > policy.refunds.maxAutoApproveCents) {
      throw new BadRequestException(
        `${amount / 100} ${invoice.currency.toUpperCase()} exceeds the auto-approve ceiling of ${policy.refunds.maxAutoApproveCents / 100}. Send force=true to override.`,
      );
    }

    const mode = req.mode ?? policy.refunds.mode;
    const reason = req.reason ?? policy.refunds.defaultReason;

    if (mode === 'credit_note') {
      const params: Stripe.CreditNoteCreateParams = {
        invoice: invoice.id!,
        amount,
        refund_amount: amount,
        reason,
        memo: req.memo ?? 'Refund issued from the OptiSigns billing demo',
      };
      const creditNote = await this.stripe.call('creditNotes.create', () =>
        this.stripe.client.creditNotes.create(params),
      );
      await this.events.record({
        accountId: account.id,
        action: 'refund.credit_note',
        summary: `Credit note ${creditNote.number} for ${amount / 100} ${invoice.currency.toUpperCase()} (refunded to card)`,
        policyApplied: policy.refunds,
        stripeRequest: params,
        result: {
          creditNoteId: creditNote.id,
          total: creditNote.total,
          refundAmount: (creditNote as any).refund_amount ?? amount,
        },
      });
      return { mode, creditNote };
    }

    const payment = await this.stripe.findInvoicePayment(invoice.id!);
    if (!payment.paymentIntent && !payment.charge) {
      throw new BadRequestException('No PaymentIntent found on this invoice — nothing to refund');
    }
    const params: Stripe.RefundCreateParams = {
      amount,
      ...(payment.paymentIntent ? { payment_intent: payment.paymentIntent } : { charge: payment.charge }),
      metadata: { accountId: account.id, invoice: invoice.id!, memo: req.memo ?? '' },
    };
    const refund = await this.stripe.call('refunds.create', () => this.stripe.client.refunds.create(params));
    await this.events.record({
      accountId: account.id,
      action: 'refund.payment_intent',
      summary: `Refunded ${amount / 100} ${invoice.currency.toUpperCase()} to the payment method`,
      policyApplied: policy.refunds,
      stripeRequest: params,
      result: { refundId: refund.id, status: refund.status },
    });
    return { mode, refund };
  }

  /**
   * Turns an account credit (created by a downgrade proration) into real money
   * back on the card: refund the last payment, then debit the customer balance
   * by the same amount so the credit is not granted twice.
   */
  async convertCreditToRefund(account: AccountDocument, creditCents: number, reason: string) {
    if (creditCents <= 0) return null;
    const invoices = await this.stripe.call('invoices.list', () =>
      this.stripe.client.invoices.list({ customer: account.stripeCustomerId!, status: 'paid', limit: 10 }),
    );

    let remaining = creditCents;
    const refunds: Stripe.Refund[] = [];
    for (const invoice of invoices.data) {
      if (remaining <= 0) break;
      const refundable = await this.refundableAmount(invoice);
      if (refundable <= 0) continue;
      const payment = await this.stripe.findInvoicePayment(invoice.id!);
      if (!payment.paymentIntent && !payment.charge) continue;
      const amount = Math.min(remaining, refundable);
      const refund = await this.stripe.call('refunds.create', () =>
        this.stripe.client.refunds.create({
          amount,
          ...(payment.paymentIntent ? { payment_intent: payment.paymentIntent } : { charge: payment.charge }),
          metadata: { accountId: account.id, invoice: invoice.id!, reason },
        }),
      );
      refunds.push(refund);
      remaining -= amount;
    }

    const refunded = creditCents - remaining;
    if (refunded > 0) {
      // Debit the balance so the customer does not also get the credit.
      await this.stripe.call('customers.createBalanceTransaction', () =>
        this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
          amount: refunded,
          currency: this.stripe.currency,
          description: `Offset: ${refunded / 100} refunded to the payment method (${reason})`,
        }),
      );
    }

    await this.events.record({
      accountId: account.id,
      action: 'refund.from_credit',
      summary:
        refunded > 0
          ? `Converted ${refunded / 100} ${this.stripe.currency.toUpperCase()} of proration credit into a card refund`
          : 'No refundable payment found, credit stayed on the customer balance',
      stripeRequest: { creditCents, reason },
      result: { refunded, unrefunded: remaining, refundIds: refunds.map((r) => r.id) },
    });

    return { refunded, unrefunded: remaining, refunds };
  }

  async listCreditNotes(accountId: string) {
    const account = await this.accounts.get(accountId);
    const notes = await this.stripe.call('creditNotes.list', () =>
      this.stripe.client.creditNotes.list({ customer: account.stripeCustomerId!, limit: 25 }),
    );
    return notes.data.map((n) => ({
      id: n.id,
      number: n.number,
      invoice: n.invoice,
      total: n.total,
      currency: n.currency,
      reason: n.reason,
      status: n.status,
      created: n.created,
      memo: n.memo,
      pdf: n.pdf,
    }));
  }

  /**
   * Lists refunds by walking the customer's charges. Filtering a global
   * `refunds.list` by metadata misses every refund Stripe creates on our
   * behalf — credit notes with `refund_amount` carry no metadata at all.
   */
  async listRefunds(accountId: string) {
    const account = await this.accounts.get(accountId);
    const charges = await this.stripe.call('charges.list', () =>
      this.stripe.client.charges.list({
        customer: account.stripeCustomerId!,
        limit: 50,
        expand: ['data.refunds'],
      }),
    );

    const rows = charges.data.flatMap((charge) =>
      (charge.refunds?.data ?? []).map((r) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        reason: r.reason,
        created: r.created,
        paymentIntent: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id,
        source: (r.metadata as any)?.reason ? 'api' : 'credit_note_or_dashboard',
        metadata: r.metadata,
      })),
    );
    return rows.sort((a, b) => b.created - a.created);
  }

  // ---------------------------------------------------------- billing portal

  /**
   * Projects the local billing policy onto a Stripe Customer Portal
   * configuration, so self-serve changes made inside Stripe's own UI follow
   * exactly the same proration and cancellation rules.
   */
  async syncPortalConfiguration() {
    const policy = await this.policy.get();
    const plans = await this.catalog.plans();
    const addons = await this.catalog.addons();

    const products = [...plans, ...addons]
      .filter((item) => item.stripeProductId && (item.monthlyPrice?.priceId || item.yearlyPrice?.priceId))
      .map((item) => ({
        product: item.stripeProductId!,
        prices: [item.monthlyPrice?.priceId, item.yearlyPrice?.priceId].filter(Boolean) as string[],
      }));

    if (products.length === 0) {
      throw new BadRequestException('Run POST /api/catalog/sync-stripe before configuring the portal');
    }

    const params: Stripe.BillingPortal.ConfigurationCreateParams = {
      business_profile: { headline: 'OptiSigns — manage your screens' },
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name', 'tax_id'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price', 'quantity', 'promotion_code'],
          proration_behavior: policy.rules.screensIncrease.prorationBehavior,
          products,
        },
        subscription_cancel: {
          enabled: true,
          mode: policy.cancellation.timing === 'immediate' ? 'immediately' : 'at_period_end',
          proration_behavior: policy.cancellation.prorateUnusedTime ? 'create_prorations' : 'none',
          cancellation_reason: {
            enabled: true,
            options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
          },
        },
      },
      metadata: { demo: 'optisigns-billing' },
    };

    // Reuse the configuration we created last time instead of piling up a new
    // one on every sync, and remember it so portal sessions actually use it.
    const existingId = await this.policy.getPortalConfigurationId();
    let configuration: Stripe.BillingPortal.Configuration | null = null;
    if (existingId) {
      try {
        configuration = await this.stripe.client.billingPortal.configurations.update(existingId, params as any);
      } catch (err: any) {
        this.logger.warn(`Portal configuration ${existingId} could not be updated (${err.message}), creating a new one`);
      }
    }
    if (!configuration) {
      configuration = await this.stripe.call('billingPortal.configurations.create', () =>
        this.stripe.client.billingPortal.configurations.create(params),
      );
    }
    await this.policy.setPortalConfigurationId(configuration.id);

    await this.events.record({
      action: 'portal.configuration_synced',
      summary: `Portal configuration ${configuration.id} now mirrors the billing policy (${existingId === configuration.id ? 'updated' : 'created'})`,
      policyApplied: { cancellation: policy.cancellation, update: policy.rules.screensIncrease },
      stripeRequest: params as any,
      result: { configurationId: configuration.id, reused: existingId === configuration.id },
    });

    return configuration;
  }

  async createPortalSession(accountId: string, returnUrl: string, configurationId?: string) {
    const account = await this.accounts.get(accountId);
    // Fall back to the configuration built from the billing policy, so what the
    // customer can do in Stripe's own UI matches the rules in this app.
    const configuration = configurationId ?? (await this.policy.getPortalConfigurationId()) ?? undefined;
    const session = await this.stripe.call('billingPortal.sessions.create', () =>
      this.stripe.client.billingPortal.sessions.create({
        customer: account.stripeCustomerId!,
        return_url: returnUrl,
        configuration,
      }),
    );
    return { url: session.url, id: session.id, configuration: configuration ?? 'stripe default' };
  }

  private async recordInvoiceEvent(invoice: Stripe.Invoice, action: string, summary: string) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const account = customerId ? await this.accounts.findByCustomerId(customerId) : null;
    await this.events.record({
      accountId: account?.id,
      action,
      summary: `${summary} — ${invoice.number ?? invoice.id}`,
      result: this.stripe.summarizeInvoice(invoice) as any,
    });
  }
}
