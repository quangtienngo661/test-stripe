import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingEvent, BillingEventDocument } from './event.schema';

export interface RecordEventInput {
  accountId?: string;
  action: string;
  source?: 'api' | 'webhook';
  ruleKey?: string;
  summary?: string;
  policyApplied?: Record<string, any>;
  stripeRequest?: Record<string, any>;
  result?: Record<string, any>;
  error?: Record<string, any>;
  stripeEventId?: string;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectModel(BillingEvent.name) private readonly model: Model<BillingEventDocument>,
  ) {}

  async record(input: RecordEventInput): Promise<BillingEventDocument> {
    this.logger.log(`${input.action}${input.ruleKey ? ` [${input.ruleKey}]` : ''} ${input.summary ?? ''}`);
    return this.model.create({ source: 'api', ...input });
  }

  async list(accountId?: string, limit = 100): Promise<BillingEventDocument[]> {
    const filter = accountId ? { accountId } : {};
    return this.model.find(filter).sort({ createdAt: -1 }).limit(limit).lean<BillingEventDocument[]>().exec();
  }

  async clear(accountId?: string): Promise<number> {
    const res = await this.model.deleteMany(accountId ? { accountId } : {});
    return res.deletedCount ?? 0;
  }
}
