import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';

/** Full daemon module graph. The CLI never imports this module. */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
