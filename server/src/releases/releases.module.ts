import { Module } from '@nestjs/common';
import { DbExecutor } from '../db/types.js';
import { PgDbService } from '../db/pg-db.service.js';
import { NodeSimulatorService } from '../simulator/node-simulator.service.js';
import { SeedService } from '../seed/seed.service.js';
import { ReleasesController } from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  controllers: [ReleasesController],
  providers: [
    { provide: DbExecutor, useClass: PgDbService },
    NodeSimulatorService,
    SeedService,
    ReleasesService,
  ],
  exports: [DbExecutor, NodeSimulatorService, SeedService, ReleasesService],
})
export class ReleasesModule {}
