import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BillingTerm } from '../catalog/catalog.constants';

export type AccountDocument = HydratedDocument<Account>;

@Schema({ _id: false })
export class AddOnSelection {
  @Prop({ required: true }) code!: string;
  @Prop({ required: true, default: 0 }) quantity!: number;
  /** Stripe subscription item id, so we can update/delete the exact line */
  @Prop() stripeItemId?: string;
}
export const AddOnSelectionSchema = SchemaFactory.createForClass(AddOnSelection);

@Schema({ timestamps: true, collection: 'accounts' })
export class Account {
  @Prop({ required: true, unique: true, index: true })
  email!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  company?: string;

  @Prop({ index: true })
  stripeCustomerId?: string;

  /** Stripe test clock, so the demo can fast-forward to the next renewal */
  @Prop()
  testClockId?: string;

  @Prop()
  defaultPaymentMethodId?: string;

  @Prop()
  paymentMethodLabel?: string;

  // ---- current subscription state (mirrored from Stripe) ----
  @Prop({ default: 'free' })
  planCode!: string;

  @Prop({ default: 'monthly' })
  term!: BillingTerm;

  @Prop({ default: 0 })
  screens!: number;

  @Prop({ type: [AddOnSelectionSchema], default: [] })
  addOns!: AddOnSelection[];

  @Prop()
  stripeSubscriptionId?: string;

  @Prop()
  stripeBaseItemId?: string;

  @Prop()
  stripeScheduleId?: string;

  @Prop({ default: 'none' })
  subscriptionStatus!: string;

  @Prop()
  currentPeriodStart?: number;

  @Prop()
  currentPeriodEnd?: number;

  @Prop()
  trialEnd?: number;

  @Prop({ default: false })
  cancelAtPeriodEnd!: boolean;

  @Prop()
  pauseBehavior?: string;

  /** a scheduled change that has not taken effect yet (end_of_period rules) */
  @Prop({ type: Object })
  pendingChange?: Record<string, any>;

  /** cancelled while cancellation.moveToFreePlan was off: no screens at all */
  @Prop({ default: false })
  deactivated!: boolean;

  /**
   * Simulated usage meter, keyed by add-on family: how much of this period's
   * allowance has been spent. In production this number belongs to whatever
   * service does the metering; here it is a knob, the same way the test clock
   * is a knob for time.
   */
  @Prop({ type: Object, default: {} })
  usage!: Record<string, number>;

  /**
   * Which allowance month each meter reading belongs to, as the unix second
   * that month started. A reading stamped with a month that has passed is
   * spent: its leftovers are forfeited rather than carried over, so the meter
   * reads zero again without anything having to fire on the boundary.
   */
  @Prop({ type: Object, default: {} })
  usageCycleStart!: Record<string, number>;

  /**
   * The allowance actually granted for the month in progress, keyed by add-on
   * family. It cannot be derived from the catalog any more: an add-on taken
   * part-way through a month grants only the part that is left, so the cap a
   * customer holds this month is a fact about the purchase rather than about
   * the price book. Stamped with the month it belongs to; a stamp from a month
   * that has passed means the next month starts whole again.
   */
  @Prop({ type: Object, default: {} })
  quotaCap!: Record<string, number>;

  @Prop({ type: Object, default: {} })
  quotaCapCycleStart!: Record<string, number>;

  /**
   * What was actually invoiced for that family for the month in progress, in
   * cents. MODEL V5 row 8 values a refund against what the customer really
   * paid for this item this period, which after a mid-month purchase is not the
   * list price — so the figure is recorded when it is charged.
   */
  @Prop({ type: Object, default: {} })
  quotaInvoicedCents!: Record<string, number>;

  /** subscription items whose Stripe price is no longer in the catalog */
  @Prop({ type: [String], default: [] })
  unmappedPriceIds!: string[];
}

export const AccountSchema = SchemaFactory.createForClass(Account);
