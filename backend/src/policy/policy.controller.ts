import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { POLICY_FIELDS } from './policy.fields';
import { BillingPolicyShape } from './policy.types';

@Controller('policy')
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  @Get()
  async get() {
    const doc = await this.policy.getDoc();
    return {
      basedOnPreset: doc.basedOnPreset,
      policy: doc.policy,
      warnings: PolicyService.lint(doc.policy),
      updatedAt: (doc as any).updatedAt,
    };
  }

  @Get('fields')
  fields() {
    return POLICY_FIELDS;
  }

  @Get('presets')
  presets() {
    return this.policy.presets();
  }

  @Put()
  async update(@Body() body: Partial<BillingPolicyShape>) {
    const doc = await this.policy.update(body);
    return { basedOnPreset: doc.basedOnPreset, policy: doc.policy };
  }

  @Post('presets/:key')
  async apply(@Param('key') key: string) {
    const doc = await this.policy.applyPreset(key);
    return { basedOnPreset: doc.basedOnPreset, policy: doc.policy };
  }
}
