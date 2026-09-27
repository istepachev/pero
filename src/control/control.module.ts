import { type DynamicModule, Module } from '@nestjs/common';
import type { DataDirLayout } from '../config/data-dir.js';
import { HealthModule } from '../health/health.module.js';
import { CONTROL_LAYOUT, ControlService } from './control.service.js';

export interface ControlOptions {
  layout: DataDirLayout;
}

/** The owner-only control endpoint the CLI talks to. */
@Module({})
export class ControlModule {
  static forRoot(options: ControlOptions): DynamicModule {
    return {
      module: ControlModule,
      imports: [HealthModule],
      providers: [
        { provide: CONTROL_LAYOUT, useValue: options.layout },
        ControlService,
      ],
      exports: [ControlService],
    };
  }
}
