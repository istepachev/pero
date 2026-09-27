import { Module } from '@nestjs/common';
import { ComponentHealth } from './component-health.js';

@Module({
  providers: [ComponentHealth],
  exports: [ComponentHealth],
})
export class HealthModule {}
