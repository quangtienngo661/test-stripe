import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingEvent, BillingEventSchema } from './event.schema';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: BillingEvent.name, schema: BillingEventSchema }])],
  providers: [EventsService],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
