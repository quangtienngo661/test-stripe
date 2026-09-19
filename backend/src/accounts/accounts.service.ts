import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { StripeService } from '../stripe/stripe.service';
import { allowanceCycle } from '../stripe/allowance-cycle';
import { EventsService } from '../events/events.service';
import { Account, AccountDocument } from './account.schema';

/** Stripe's shared test payment methods — no card data ever touches this app. */
export const TEST_PAYMENT_METHODS: Record<string, { id: string; label: string }> = {
  visa: { id: 'pm_card_visa', label: 'Visa •••• 4242 — every charge succeeds' },
  mastercard: { id: 'pm_card_mastercard', label: 'Mastercard •••• 4444 — every charge succeeds' },
  /*
   * Stripe validates a card when it is attached, so the classic "declined"
   * cards can never be saved to a customer at all. For dunning you need the one
   * card that attaches cleanly and then fails whenever it is charged.
   */
  charge_fails: {
    id: 'pm_card_chargeCustomerFail',
    label: 'Visa — saves fine, then every charge fails (dunning demo)',
  },
  needs_3ds: {
    id: 'pm_card_authenticationRequired',
    label: 'Visa •••• 3155 — saves fine, charges need 3D Secure',
  },
  declined_on_save: {
    id: 'pm_card_chargeDeclined',
    label: 'Visa •••• 0002 — refused the moment it is saved',
  },
  no_funds_on_save: {
    id: 'pm_card_chargeDeclinedInsufficientFunds',
    label: 'Visa •••• 9995 — refused on save, insufficient funds',
  },
};

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectModel(Account.name) private readonly model: Model<AccountDocument>,
    private readonly stripe: StripeService,
    private readonly events: EventsService,
  ) {}

  async list(): Promise<AccountDocument[]> {
    return this.model.find().sort({ createdAt: -1 }).exec();
  }

  async get(id: string): Promise<AccountDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`Account ${id} not found`);
    const account = await this.model.findById(id).exec();
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return account;
  }

  async findByCustomerId(customerId: string): Promise<AccountDocument | null> {
    return this.model.findOne({ stripeCustomerId: customerId }).exec();
  }

  async findBySubscriptionId(subscriptionId: string): Promise<AccountDocument | null> {
    return this.model.findOne({ stripeSubscriptionId: subscriptionId }).exec();
  }

  /**
   * Creates the local account plus its Stripe customer. `withTestClock` binds
   * the customer to a Stripe test clock, which is what makes the "advance time"
   * simulator work — it can only be set at customer creation time.
   */
  async create(input: {
    email: string;
    name: string;
    company?: string;
    withTestClock?: boolean;
    clockStart?: number;
  }): Promise<AccountDocument> {
    const existing = await this.model.findOne({ email: input.email }).exec();
    if (existing) throw new BadRequestException(`Account with email ${input.email} already exists`);

    let testClockId: string | undefined;
    if (input.withTestClock) {
      const clock = await this.stripe.call('testClocks.create', () =>
        this.stripe.client.testHelpers.testClocks.create({
          frozen_time: input.clockStart ?? Math.floor(Date.now() / 1000),
          name: `Demo clock — ${input.email}`,
        }),
      );
      testClockId = clock.id;
    }

    const customer = await this.stripe.call('customers.create', () =>
      this.stripe.client.customers.create({
        email: input.email,
        name: input.name,
        description: input.company ? `OptiSigns demo — ${input.company}` : 'OptiSigns billing demo',
        test_clock: testClockId,
        metadata: { demo: 'optisigns-billing', company: input.company ?? '' },
      }),
    );

    const account = await this.model.create({
      email: input.email,
      name: input.name,
      company: input.company,
      stripeCustomerId: customer.id,
      testClockId,
      planCode: 'free',
      screens: 0,
      subscriptionStatus: 'none',
    });

    await this.events.record({
      accountId: account.id,
      action: 'account.created',
      summary: `Stripe customer ${customer.id}${testClockId ? ` on test clock ${testClockId}` : ''}`,
      stripeRequest: { email: input.email, test_clock: testClockId },
      result: { customerId: customer.id, testClockId },
    });

    return account;
  }

  async remove(id: string): Promise<void> {
    const account = await this.get(id);
    if (account.stripeCustomerId) {
      try {
        await this.stripe.client.customers.del(account.stripeCustomerId);
      } catch (err: any) {
        this.logger.warn(`Could not delete Stripe customer: ${err.message}`);
      }
    }
    /*
     * Deleting the customer leaves its test clock behind, and clocks pile up
     * fast when every demo account gets one. Deleting the clock also removes
     * anything still attached to it.
     */
    if (account.testClockId) {
      try {
        await this.stripe.client.testHelpers.testClocks.del(account.testClockId);
      } catch (err: any) {
        this.logger.warn(`Could not delete test clock ${account.testClockId}: ${err.message}`);
      }
    }
    await this.model.deleteOne({ _id: account._id }).exec();
  }

  /**
   * Attaches one of Stripe's shared test payment methods and makes it the
   * customer's invoice default. Real card data is never handled here.
   */
  async attachTestPaymentMethod(id: string, kind: keyof typeof TEST_PAYMENT_METHODS): Promise<AccountDocument> {
    const account = await this.get(id);
    const pm = TEST_PAYMENT_METHODS[kind];
    if (!pm) throw new BadRequestException(`Unknown test card "${kind}"`);

    const attached = await this.stripe.call('paymentMethods.attach', () =>
      this.stripe.client.paymentMethods.attach(pm.id, { customer: account.stripeCustomerId! }),
    );
    await this.stripe.call('customers.update', () =>
      this.stripe.client.customers.update(account.stripeCustomerId!, {
        invoice_settings: { default_payment_method: attached.id },
      }),
    );
    /*
     * A running subscription keeps whatever payment method it was created with,
     * so without this it would quietly keep charging the old card while the UI
     * claims the new one is in use.
     */
    if (account.stripeSubscriptionId) {
      try {
        await this.stripe.client.subscriptions.update(account.stripeSubscriptionId, {
          default_payment_method: attached.id,
        });
      } catch (err: any) {
        this.logger.warn(`Could not move subscription onto ${attached.id}: ${err.message}`);
      }
    }

    account.defaultPaymentMethodId = attached.id;
    account.paymentMethodLabel = pm.label;
    await account.save();

    await this.events.record({
      accountId: account.id,
      action: 'payment_method.attached',
      summary: pm.label,
      stripeRequest: { paymentMethod: pm.id, customer: account.stripeCustomerId },
      result: { paymentMethodId: attached.id },
    });

    return account;
  }

  /** Realistic alternative: collect a card through Stripe Checkout in setup mode. */
  async createSetupCheckoutSession(id: string, returnUrl: string) {
    const account = await this.get(id);
    const session = await this.stripe.call('checkout.sessions.create', () =>
      this.stripe.client.checkout.sessions.create({
        mode: 'setup',
        customer: account.stripeCustomerId,
        currency: this.stripe.currency,
        success_url: `${returnUrl}?setup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}?setup=cancelled`,
      }),
    );
    return { url: session.url, id: session.id };
  }

  async paymentMethods(id: string) {
    const account = await this.get(id);
    const list = await this.stripe.call('paymentMethods.list', () =>
      this.stripe.client.paymentMethods.list({ customer: account.stripeCustomerId!, type: 'card' }),
    );
    return list.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand,
      last4: pm.card?.last4,
      expMonth: pm.card?.exp_month,
      expYear: pm.card?.exp_year,
      isDefault: pm.id === account.defaultPaymentMethodId,
    }));
  }

  async setDefaultPaymentMethod(id: string, paymentMethodId: string): Promise<AccountDocument> {
    const account = await this.get(id);
    await this.stripe.call('customers.update', () =>
      this.stripe.client.customers.update(account.stripeCustomerId!, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    );
    if (account.stripeSubscriptionId) {
      await this.stripe.call('subscriptions.update', () =>
        this.stripe.client.subscriptions.update(account.stripeSubscriptionId!, {
          default_payment_method: paymentMethodId,
        }),
      );
    }
    account.defaultPaymentMethodId = paymentMethodId;
    await account.save();
    return account;
  }

  /** Sets the meter outright — "pretend they have spent this much". */
  async setUsage(id: string, family: string, used: number): Promise<AccountDocument> {
    const account = await this.get(id);
    const value = Math.max(0, Math.floor(Number(used)));
    if (!Number.isFinite(value)) throw new BadRequestException('Usage must be a whole number of 0 or more');
    account.usage = { ...(account.usage ?? {}), [family]: value };
    await this.stampCycle(account, family);
    await account.save();
    await this.events.record({
      accountId: account.id,
      action: 'usage.set',
      summary: `${family}: meter set to ${value}`,
      result: { usage: account.usage },
    });
    return account;
  }

  /** Spends some of the allowance, the way real traffic would. */
  async consumeUsage(id: string, family: string, amount: number): Promise<AccountDocument> {
    const account = await this.get(id);
    const step = Math.max(0, Math.floor(Number(amount)));
    const next = Math.max(0, (await this.readUsage(account, family)) + step);
    account.usage = { ...(account.usage ?? {}), [family]: next };
    await this.stampCycle(account, family);
    await account.save();
    await this.events.record({
      accountId: account.id,
      action: 'usage.consumed',
      summary: `${family}: +${step} → ${next}`,
      result: { usage: account.usage },
    });
    return account;
  }

  /** Called when a fresh allowance is granted: a new tier, or a new period. */
  /** Start of the allowance month the account is in, or undefined with no live period. */
  async currentCycleStart(account: AccountDocument): Promise<number | undefined> {
    if (!account.currentPeriodStart || !account.currentPeriodEnd) return undefined;
    const now = await this.stripe.nowFor(account.testClockId);
    return allowanceCycle(account.currentPeriodStart, account.currentPeriodEnd, now, account.term).cycleStart;
  }

  private async stampCycle(account: AccountDocument, family: string): Promise<void> {
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return;
    account.usageCycleStart = { ...(account.usageCycleStart ?? {}), [family]: cycleStart };
  }

  /**
   * The meter as of now. A reading left over from an allowance month that has
   * already passed is not carried over — the unused posts are forfeited — so it
   * is normalised to zero here, which is why no job has to run on the boundary.
   */
  async readUsage(account: AccountDocument, family: string): Promise<number> {
    const stored = account.usage?.[family] ?? 0;
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return stored;

    const stamp = account.usageCycleStart?.[family];
    if (stamp === undefined || stamp === null) {
      // written before the stamp existed: adopt this month rather than wipe a real number
      account.usageCycleStart = { ...(account.usageCycleStart ?? {}), [family]: cycleStart };
      await account.save();
      return stored;
    }
    if (stamp === cycleStart) return stored;

    account.usage = { ...(account.usage ?? {}), [family]: 0 };
    account.usageCycleStart = { ...(account.usageCycleStart ?? {}), [family]: cycleStart };
    await account.save();
    if (stored > 0) {
      await this.events.record({
        accountId: account.id,
        action: 'usage.rolled',
        summary: `${family}: a new allowance month began — ${stored} spent last month, ${0} now`,
        result: { usage: account.usage, cycleStart },
      });
    }
    return 0;
  }

  /**
   * Committed provider capacity across every other account, in post updates.
   *
   * MODEL V5 row 17 budgets the upstream API by what has been *sold*, not by
   * what has been spent: every licence held commits its whole monthly
   * allowance whether or not the customer posts a single update, and a trial
   * commits a nominal amount of its own. The account being changed is left out
   * so the caller can add its proposed configuration and get the figure that
   * would hold after the change.
   *
   * `allowanceByCode` carries the per-unit allowance of each usage-priced
   * add-on, so the price book stays the one place those numbers are written
   * down.
   */
  async committedCapacityExcluding(
    accountId: string | null,
    allowanceByCode: Map<string, number>,
    trialUnits: number,
  ): Promise<{ total: number; fromLicences: number; fromTrials: number; accounts: number }> {
    const rows = await this.model
      .find({}, { addOns: 1, subscriptionStatus: 1 })
      .lean<{ _id: Types.ObjectId; addOns?: { code: string; quantity: number }[]; subscriptionStatus?: string }[]>();

    let fromLicences = 0;
    let trials = 0;
    let counted = 0;
    for (const row of rows) {
      if (accountId && String(row._id) === String(accountId)) continue;
      counted += 1;
      for (const addOn of row.addOns ?? []) {
        const perUnit = allowanceByCode.get(addOn.code);
        if (perUnit) fromLicences += perUnit * (addOn.quantity ?? 0);
      }
      if (row.subscriptionStatus === 'trialing') trials += 1;
    }
    const fromTrials = trials * trialUnits;
    return { total: fromLicences + fromTrials, fromLicences, fromTrials, accounts: counted };
  }

  /**
   * The allowance this account actually holds for the month in progress.
   *
   * A stamp from the month in progress means the cap was set when the add-on
   * was bought part-way through it, and that figure stands. Anything else — no
   * stamp, or a stamp from a month that has passed — means the month was never
   * bought into partially, so it starts whole: `fullAllowance` is the catalog
   * allowance already multiplied by the quantity held.
   */
  async quotaCapFor(account: AccountDocument, family: string, fullAllowance: number): Promise<number> {
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return fullAllowance;
    const stamp = account.quotaCapCycleStart?.[family];
    if (stamp !== cycleStart) return fullAllowance;
    const cap = account.quotaCap?.[family];
    return typeof cap === 'number' ? cap : fullAllowance;
  }

  /** What was really invoiced for this family this month, for MODEL V5 row 8. */
  async quotaInvoicedFor(account: AccountDocument, family: string, fallbackCents: number): Promise<number> {
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return fallbackCents;
    if (account.quotaCapCycleStart?.[family] !== cycleStart) return fallbackCents;
    const cents = account.quotaInvoicedCents?.[family];
    return typeof cents === 'number' ? cents : fallbackCents;
  }

  /**
   * Record a part-month grant: how many posts it opened and what was charged
   * for them. Both are stamped with the month they belong to, so the next month
   * falls back to a whole allowance without anything having to fire on the
   * boundary — the same trick the meter itself uses.
   */
  async recordQuotaGrant(
    account: AccountDocument,
    family: string,
    cap: number,
    invoicedCents: number,
  ): Promise<void> {
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return;
    account.quotaCap = { ...(account.quotaCap ?? {}), [family]: cap };
    account.quotaInvoicedCents = { ...(account.quotaInvoicedCents ?? {}), [family]: invoicedCents };
    account.quotaCapCycleStart = { ...(account.quotaCapCycleStart ?? {}), [family]: cycleStart };
    await account.save();
  }

  /**
   * Add to a family's grant instead of replacing it.
   *
   * Buying more licences mid-month tops the month up: the posts already granted
   * stay granted and the money already invoiced stays counted, because a later
   * hand-back has to be valued against *everything* paid for this month, not
   * just the last slice of it. The base comes from the same readers the rest of
   * the engine uses, so a month that was never part-bought starts from its
   * whole allowance rather than from nothing.
   */
  async addQuotaGrant(
    account: AccountDocument,
    family: string,
    added: { cap: number; cents: number },
    base: { fullAllowance: number; listRateCents: number },
  ): Promise<void> {
    const cycleStart = await this.currentCycleStart(account);
    if (cycleStart === undefined) return;
    const cap = await this.quotaCapFor(account, family, base.fullAllowance);
    const invoiced = await this.quotaInvoicedFor(account, family, base.listRateCents);
    account.quotaCap = { ...(account.quotaCap ?? {}), [family]: cap + added.cap };
    account.quotaInvoicedCents = {
      ...(account.quotaInvoicedCents ?? {}),
      [family]: invoiced + added.cents,
    };
    account.quotaCapCycleStart = { ...(account.quotaCapCycleStart ?? {}), [family]: cycleStart };
    await account.save();
  }

  /** Drop a family's grant record, e.g. when the add-on is given up entirely. */
  async clearQuotaGrant(account: AccountDocument, family: string): Promise<void> {
    if (account.quotaCap?.[family] === undefined) return;
    const strip = (o: Record<string, any> | undefined) => {
      const next = { ...(o ?? {}) };
      delete next[family];
      return next;
    };
    account.quotaCap = strip(account.quotaCap);
    account.quotaInvoicedCents = strip(account.quotaInvoicedCents);
    account.quotaCapCycleStart = strip(account.quotaCapCycleStart);
    await account.save();
  }

  async resetUsage(account: AccountDocument, family: string, reason: string): Promise<void> {
    if (!account.usage?.[family]) return;
    account.usage = { ...(account.usage ?? {}), [family]: 0 };
    await this.stampCycle(account, family);
    await account.save();
    await this.events.record({
      accountId: account.id,
      action: 'usage.reset',
      summary: `${family}: meter back to 0 — ${reason}`,
      result: { usage: account.usage },
    });
  }

  /** Stripe customer balance: negative = credit the customer can spend. */
  async balance(id: string) {
    const account = await this.get(id);
    const customer = await this.stripe.call('customers.retrieve', () =>
      this.stripe.client.customers.retrieve(account.stripeCustomerId!),
    );
    const transactions = await this.stripe.call('customers.listBalanceTransactions', () =>
      this.stripe.client.customers.listBalanceTransactions(account.stripeCustomerId!, { limit: 20 }),
    );
    return {
      balance: (customer as any).balance ?? 0,
      currency: this.stripe.currency,
      transactions: transactions.data.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        created: t.created,
        endingBalance: t.ending_balance,
        invoice: t.invoice,
      })),
    };
  }

  /** Manual credit/debit, e.g. a goodwill credit from support. */
  async adjustBalance(id: string, amountCents: number, description: string) {
    const account = await this.get(id);
    const tx = await this.stripe.call('customers.createBalanceTransaction', () =>
      this.stripe.client.customers.createBalanceTransaction(account.stripeCustomerId!, {
        amount: amountCents,
        currency: this.stripe.currency,
        description,
      }),
    );
    await this.events.record({
      accountId: account.id,
      action: 'customer.balance_adjusted',
      summary: `${amountCents < 0 ? 'Credited' : 'Debited'} ${Math.abs(amountCents) / 100} ${this.stripe.currency.toUpperCase()} — ${description}`,
      stripeRequest: { amount: amountCents, description },
      result: { id: tx.id, endingBalance: tx.ending_balance },
    });
    return tx;
  }

  save(account: AccountDocument) {
    return account.save();
  }
}
