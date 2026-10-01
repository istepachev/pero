import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { HostConfigService } from '../host-config/host-config.service.js';
import {
  type AgentDefinition,
  type Defaults,
  Definitions,
  type Route,
  type WorkflowDefinition,
} from './definitions.js';
import { readLegacyDefaults } from './legacy-definitions.js';

/**
 * A legacy data directory's definitions, which have no Agents or Workflows,
 * since only a workspace's notes define them: every Channel is told so.
 * The defaults it kept in `legacy_settings` still apply, with the data
 * folder `config.yaml` names. Nothing changes them, so `onChange` never
 * calls.
 */
@Injectable()
export class LegacyDataDirDefinitions extends Definitions {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // Absent where nothing reads `config.yaml`, as in some specs.
    @Optional() private readonly hostConfig?: HostConfigService,
  ) {
    super();
  }

  async defaults(): Promise<Defaults> {
    return {
      ...(await readLegacyDefaults(this.dataSource)),
      dataFolder: this.hostConfig?.dataFolder() ?? null,
    };
  }

  agent(): Promise<AgentDefinition | null> {
    return Promise.resolve(null);
  }

  agents(): Promise<AgentDefinition[]> {
    return Promise.resolve([]);
  }

  mainAgent(): Promise<AgentDefinition | null> {
    return Promise.resolve(null);
  }

  mainAgentName(): Promise<string | null> {
    return Promise.resolve(null);
  }

  route(): Promise<Route> {
    return Promise.resolve({
      kind: 'unanswered',
      reason: { kind: 'legacy' },
    });
  }

  workflow(): Promise<WorkflowDefinition | null> {
    return Promise.resolve(null);
  }

  workflows(): Promise<WorkflowDefinition[]> {
    return Promise.resolve([]);
  }

  onChange(): () => void {
    return () => undefined;
  }
}
