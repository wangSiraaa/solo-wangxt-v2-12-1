import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminController,
  CertsController,
  NodesController,
  ReceiptsController,
  ReleasesController,
} from './controllers';
import { EngineService } from './engine.service';
import {
  CertEntity,
  ControlSwitchEntity,
  DispatchRequestEntity,
  NodeControlEntity,
  NodeEntity,
  ReceiptEntity,
  ReleaseEntity,
  ReleaseTaskEntity,
} from './entities';
import { ReceiptsService } from './receipts.service';
import { ReleasesService } from './releases.service';
import { RuntimeConfig } from './runtime-config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres' as const,
        url: process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
        entities: [
          CertEntity,
          NodeEntity,
          ReleaseEntity,
          ReleaseTaskEntity,
          NodeControlEntity,
          ControlSwitchEntity,
          DispatchRequestEntity,
          ReceiptEntity,
        ],
        synchronize: true,
        logging: false,
      }),
    }),
  ],
  controllers: [CertsController, NodesController, ReleasesController, ReceiptsController, AdminController],
  providers: [RuntimeConfig, EngineService, ReleasesService, ReceiptsService],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    private readonly engine: EngineService,
    private readonly config: RuntimeConfig,
  ) {}

  async onApplicationBootstrap() {
    // Restore control state and unfinished work from the database after a
    // restart. Nothing is held in process-local collections.
    if (this.config.recoveryEnabled) {
      await this.engine.recover();
    }
  }
}
