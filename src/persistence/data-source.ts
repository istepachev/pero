import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { resolveBootstrapConfig } from '../config/bootstrap-config.js';
import { workspaceLayout } from '../config/workspace-layout.js';
import { dataSourceOptions } from './data-source-options.js';

// For the TypeORM CLI behind the `migration:*` npm scripts only; the daemon
// opens the database through PersistenceModule. Targets `PERO_WORKSPACE`,
// which those scripts default to the repository as a development workspace.
const { workspace } = resolveBootstrapConfig();

export default new DataSource(
  dataSourceOptions(workspaceLayout(workspace).database),
);
