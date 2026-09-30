import { Module } from '@nestjs/common';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { SettingsNotesModule } from '../settings-notes/settings-notes.module.js';
import { Definitions } from './definitions.js';
import { FileDefinitions } from './file-definitions.js';
import { LegacyDataDirDefinitions } from './legacy-data-dir-definitions.js';

/**
 * The definitions runtime code reads: `Definitions`. In a workspace, they
 * come from its notes; a legacy data directory has none. Needs the
 * database from `PersistenceModule`.
 */
@Module({
  imports: [SettingsNotesModule],
  providers: [
    LegacyDataDirDefinitions,
    FileDefinitions,
    {
      provide: Definitions,
      useFactory: (
        notes: SettingsNotes,
        legacy: LegacyDataDirDefinitions,
        files: FileDefinitions,
      ) => (notes.inWorkspace() ? files : legacy),
      inject: [SettingsNotes, LegacyDataDirDefinitions, FileDefinitions],
    },
  ],
  exports: [Definitions, SettingsNotesModule],
})
export class DefinitionsModule {}
