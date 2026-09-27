import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../app.module.js';

// Loopback only: the HTTP surface is private until administration is authenticated.
const HOST = '127.0.0.1';
const DEFAULT_PORT = 7717;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PERO_PORT ?? DEFAULT_PORT), HOST);
}

await bootstrap();
