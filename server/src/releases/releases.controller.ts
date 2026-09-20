import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { CreateReleaseDto, ReceiptDto } from './types.js';
import { ReleasesService } from './releases.service.js';
import { SeedService } from '../seed/seed.service.js';

@Controller('api')
export class ReleasesController {
  constructor(
    private readonly releases: ReleasesService,
    private readonly seed: SeedService,
  ) {}

  @Get('snapshot')
  snapshot() {
    return this.releases.snapshot();
  }

  @Post('demo/reset')
  reset() {
    return this.seed.resetForDemo();
  }

  @Put('nodes/:nodeId/behavior')
  setBehavior(@Param('nodeId') nodeId: string, @Body() body: { behavior: 'succeed' | 'fail' | 'late_success' }) {
    return this.releases.setNodeBehavior(nodeId, body.behavior);
  }

  @Post('releases/normal')
  createNormal(@Body() dto: CreateReleaseDto) {
    return this.releases.createNormal(dto);
  }

  @Post('releases/emergency/preview')
  previewEmergency(@Body() dto: CreateReleaseDto) {
    return this.releases.previewEmergency(dto);
  }

  @Post('releases/emergency/confirm')
  confirmEmergency(@Body() dto: CreateReleaseDto) {
    return this.releases.confirmEmergency(dto);
  }

  @Get('releases/:id')
  details(@Param('id') id: string) {
    return this.releases.getReleaseDetails(id);
  }

  @Post('releases/:id/canary/approve')
  approve(@Param('id') id: string) {
    return this.releases.approveCanary(id);
  }

  @Post('releases/:id/retry')
  retry(@Param('id') id: string) {
    return this.releases.retryFailed(id);
  }

  @Post('releases/:id/rollback')
  rollback(@Param('id') id: string) {
    return this.releases.rollbackNormal(id);
  }

  @Post('releases/:id/cancel-emergency')
  cancelEmergency(@Param('id') id: string) {
    return this.releases.cancelEmergency(id);
  }

  @Post('tasks/:taskId/receipt')
  receipt(@Param('taskId') taskId: string, @Body() dto: ReceiptDto) {
    return this.releases.receiveReceipt(taskId, dto);
  }
}
