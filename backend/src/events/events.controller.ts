import { Controller, Delete, Get, Query } from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Query('accountId') accountId?: string, @Query('limit') limit?: string) {
    return this.events.list(accountId, limit ? Number(limit) : 100);
  }

  @Delete()
  async clear(@Query('accountId') accountId?: string) {
    return { deleted: await this.events.clear(accountId) };
  }
}
