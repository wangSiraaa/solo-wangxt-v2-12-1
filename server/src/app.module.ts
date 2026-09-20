import { Module } from '@nestjs/common';
import { ReleasesModule } from './releases/releases.module.js';

@Module({
  imports: [ReleasesModule],
})
export class AppModule {}
