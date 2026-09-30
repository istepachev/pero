import { Module } from '@nestjs/common';
import { DefinitionIds } from './definition-ids.js';
import { Definitions } from './definitions.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

/**
 * The definitions runtime code reads: `Definitions`, held in SQLite for
 * now. Needs the database from `PersistenceModule`.
 */
@Module({
  providers: [
    SqliteDefinitions,
    { provide: Definitions, useExisting: SqliteDefinitions },
    DefinitionIds,
  ],
  exports: [Definitions, SqliteDefinitions, DefinitionIds],
})
export class DefinitionsModule {}
