import { CreateSettings1790521767275 } from './1790521767275-CreateSettings.js';
import { CreateDomainTables1790523956072 } from './1790523956072-CreateDomainTables.js';

/**
 * Every migration in the order it runs, listed explicitly so the compiled
 * package ships them without file globbing. Append new migrations here.
 */
export const MIGRATIONS = [
  CreateSettings1790521767275,
  CreateDomainTables1790523956072,
];
