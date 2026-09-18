import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { configuration } from './config/configuration';
import { StripeModule } from './stripe/stripe.module';
import { EventsModule } from './events/events.module';
import { CatalogModule } from './catalog/catalog.module';
import { PolicyModule } from './policy/policy.module';
import { AccountsModule } from './accounts/accounts.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { BillingModule } from './billing/billing.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], envFilePath: ['.env'] }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ uri: config.get<string>('mongoUri') }),
    }),
    StripeModule,
    EventsModule,
    CatalogModule,
    PolicyModule,
    AccountsModule,
    SubscriptionsModule,
    BillingModule,
    WebhooksModule,
    SimulatorModule,
  ],
})
export class AppModule {}
