import { Module } from '@nestjs/common';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { SettingsNotesModule } from '../settings-notes/settings-notes.module.js';
import { DefinitionIds } from './definition-ids.js';
import { Definitions } from './definitions.js';
import { FileDefinitions } from './file-definitions.js';
import { SqliteDefinitions } from './sqlite-definitions.js';

/**
 * The definitions runtime code reads: `Definitions`. In a workspace, the
 * Agents and defaults come from its notes and the Workflows from SQLite;
 * a legacy data directory keeps all of them in SQLite until plan step 8.5.
 * Needs the database from `PersistenceModule`.
 */
@Module({
  imports: [SettingsNotesModule],
  providers: [
    SqliteDefinitions,
    FileDefinitions,
    {
      provide: Definitions,
      useFactory: (
        notes: SettingsNotes,
        sqlite: SqliteDefinitions,
        files: FileDefinitions,
      ) => (notes.inWorkspace() ? files : sqlite),
      inject: [SettingsNotes, SqliteDefinitions, FileDefinitions],
    },
    DefinitionIds,
  ],
  exports: [Definitions, SqliteDefinitions, DefinitionIds, SettingsNotesModule],
})
export class DefinitionsModule {}
