import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ensureDataDir } from '../src/config/data-dir.js';

describe('Daemon HTTP (e2e)', () => {
  let tmp: string;
  let app: NestFastifyApplication;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'pero-app-'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ layout: ensureDataDir(tmp) })],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
