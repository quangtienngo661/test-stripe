import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
