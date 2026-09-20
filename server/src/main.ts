import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RuntimeConfig } from './runtime-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix('api');
  const port = Number(process.env.PORT || 3000);
  // set the callback base url before listen(): boot-time recovery may
  // re-dispatch unfinished tasks while the app initialises
  const config = app.get(RuntimeConfig);
  config.publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
  await app.listen(port, '0.0.0.0');
  console.log(`[server] API listening on ${config.publicBaseUrl}/api`);
  console.log(`[server] simulator: ${config.simulatorUrl}`);
}
bootstrap();
