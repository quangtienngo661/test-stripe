import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingPolicyDoc, BillingPolicySchema } from './policy.schema';
import { PolicyService } from './policy.service';
import { PolicyController } from './policy.controller';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: BillingPolicyDoc.name, schema: BillingPolicySchema }])],
  providers: [PolicyService],
  controllers: [PolicyController],
  exports: [PolicyService],
})
export class PolicyModule {}
