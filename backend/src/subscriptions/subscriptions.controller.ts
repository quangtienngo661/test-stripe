import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { ChangeRequest } from './subscription.types';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get(':accountId')
  state(@Param('accountId') accountId: string) {
    return this.subscriptions.getState(accountId);
  }

  @Get(':accountId/renewal-preview')
  renewalPreview(@Param('accountId') accountId: string) {
    return this.subscriptions.previewRenewal(accountId);
  }

  /** Dry run — returns the exact invoice Stripe would produce. */
  @Post(':accountId/preview')
  preview(@Param('accountId') accountId: string, @Body() body: ChangeRequest) {
    return this.subscriptions.preview(accountId, body);
  }

  @Post(':accountId/change')
  change(@Param('accountId') accountId: string, @Body() body: ChangeRequest) {
    return this.subscriptions.change(accountId, body);
  }

  @Post(':accountId/cancel')
  cancel(@Param('accountId') accountId: string, @Body() body: any) {
    return this.subscriptions.cancel(accountId, body ?? {});
  }

  /** Ends a running trial now and starts real billing. */
  @Post(':accountId/end-trial')
  endTrial(@Param('accountId') accountId: string) {
    return this.subscriptions.endTrial(accountId);
  }

  /** Calls off a change parked for the renewal, before it lands (MODEL V5 row 49). */
  @Post(':accountId/cancel-scheduled-change')
  cancelScheduledChange(@Param('accountId') accountId: string) {
    return this.subscriptions.cancelScheduledChange(accountId);
  }

  @Post(':accountId/resume')
  resume(@Param('accountId') accountId: string) {
    return this.subscriptions.resume(accountId);
  }

  @Post(':accountId/pause')
  pause(@Param('accountId') accountId: string, @Body() body: { resumesAt?: number }) {
    return this.subscriptions.pause(accountId, body?.resumesAt);
  }

  @Post(':accountId/unpause')
  unpause(@Param('accountId') accountId: string) {
    return this.subscriptions.unpause(accountId);
  }
}
