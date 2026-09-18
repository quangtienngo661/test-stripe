import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BillingEventDocument = HydratedDocument<BillingEvent>;

/**
 * Every billing mutation is recorded here together with the policy that was in
 * force and the exact payload sent to Stripe. The demo UI renders this as an
 * audit trail so you can see *why* Stripe behaved the way it did.
 */
@Schema({ timestamps: true, collection: 'billing_events' })
export class BillingEvent {
  @Prop({ index: true })
  accountId?: string;

  @Prop({ required: true })
  action!: string;

  @Prop({ default: 'api' })
  source!: 'api' | 'webhook';

  @Prop()
  ruleKey?: string;

  @Prop()
  summary?: string;

  @Prop({ type: Object })
  policyApplied?: Record<string, any>;

  @Prop({ type: Object })
  stripeRequest?: Record<string, any>;

  @Prop({ type: Object })
  result?: Record<string, any>;

  @Prop({ type: Object })
  error?: Record<string, any>;

  @Prop({ index: true })
  stripeEventId?: string;
}

export const BillingEventSchema = SchemaFactory.createForClass(BillingEvent);
