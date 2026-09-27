import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { resolveBootstrapConfig } from '../config/bootstrap-config.js';
import { dataDirLayout } from '../config/data-dir.js';
import { dataSourceOptions } from './data-source-options.js';

// For the TypeORM CLI behind the `migration:*` npm scripts only; the daemon
// opens the database through PersistenceModule. Targets `PERO_HOME`, which
// those scripts default to the development data directory.
const { dataDir } = resolveBootstrapConfig();

export default new DataSource(
  dataSourceOptions(dataDirLayout(dataDir).database),
);
