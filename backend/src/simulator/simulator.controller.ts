import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdvancePreset, SimulatorService } from './simulator.service';

@Controller('simulator')
export class SimulatorController {
  constructor(private readonly simulator: SimulatorService) {}

  @Get(':accountId/clock')
  clock(@Param('accountId') accountId: string) {
    return this.simulator.clock(accountId);
  }

  @Post(':accountId/advance')
  advance(
    @Param('accountId') accountId: string,
    @Body() body: { preset?: AdvancePreset; seconds?: number; to?: number },
  ) {
    return this.simulator.advance(accountId, body ?? {});
  }
}
