import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { ReleasesService } from './releases/releases.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors({ origin: true });
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  app.get(ReleasesService).startScheduler();
}

void bootstrap();
