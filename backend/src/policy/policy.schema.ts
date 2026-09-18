import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BillingPolicyShape } from './policy.types';

export type BillingPolicyDocument = HydratedDocument<BillingPolicyDoc>;

@Schema({ timestamps: true, collection: 'billing_policies' })
export class BillingPolicyDoc {
  /** single active document, keyed 'active' */
  @Prop({ required: true, unique: true, default: 'active' })
  key!: string;

  @Prop({ default: 'optisigns_default' })
  basedOnPreset!: string;

  @Prop({ type: Object, required: true })
  policy!: BillingPolicyShape;

  /** Stripe Customer Portal configuration generated from this policy */
  @Prop()
  portalConfigurationId?: string;
}

export const BillingPolicySchema = SchemaFactory.createForClass(BillingPolicyDoc);
