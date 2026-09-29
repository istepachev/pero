import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { resolveBootstrapConfig } from '../config/bootstrap-config.js';
import { dataDirLayout } from '../config/data-dir.js';
import { dataSourceOptions } from './data-source-options.js';

// For the TypeORM CLI behind the `migration:*` npm scripts only; the daemon
// opens the database through PersistenceModule. Targets `PERO_WORKSPACE`,
// which those scripts default to the repository as a development workspace.
const { dataDir } = resolveBootstrapConfig();

export default new DataSource(
  dataSourceOptions(dataDirLayout(dataDir).database),
);
