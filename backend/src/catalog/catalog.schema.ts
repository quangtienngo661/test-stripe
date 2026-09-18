import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ItemKind } from './catalog.constants';

export type CatalogItemDocument = HydratedDocument<CatalogItem>;

@Schema({ _id: false })
export class StripePriceRef {
  @Prop() priceId?: string;
  @Prop() unitAmount?: number;
  @Prop() interval?: 'month' | 'year';
}
export const StripePriceRefSchema = SchemaFactory.createForClass(StripePriceRef);

@Schema({ timestamps: true, collection: 'catalog_items' })
export class CatalogItem {
  @Prop({ required: true, unique: true, index: true })
  code!: string;

  @Prop({ required: true })
  kind!: ItemKind;

  @Prop({ required: true })
  name!: string;

  @Prop()
  description?: string;

  @Prop({ default: 'screen' })
  unitLabel!: string;

  @Prop({ default: 0 })
  tierRank!: number;

  @Prop({ required: true })
  monthlyCents!: number;

  @Prop({ required: true })
  annualMonthlyCents!: number;

  @Prop({ default: 0 })
  minQuantity!: number;

  @Prop()
  maxQuantity?: number;

  @Prop({ default: false })
  boundToScreens!: boolean;

  /** tiered add-ons in the same family swap prices instead of stacking items */
  @Prop()
  family?: string;

  /** licensed per account: quantity is always 1, screen limits do not apply */
  @Prop({ default: false })
  perAccount!: boolean;

  /** metered allowance granted each month */
  @Prop()
  quotaAllowance?: number;

  @Prop()
  quotaLabel?: string;

  /** priced by allowance, never by the calendar */
  @Prop({ default: false })
  usagePriced!: boolean;

  @Prop({ type: [String], default: [] })
  features!: string[];

  @Prop()
  stripeProductId?: string;

  @Prop({ type: StripePriceRefSchema })
  monthlyPrice?: StripePriceRef;

  @Prop({ type: StripePriceRefSchema })
  yearlyPrice?: StripePriceRef;
}

export const CatalogItemSchema = SchemaFactory.createForClass(CatalogItem);
