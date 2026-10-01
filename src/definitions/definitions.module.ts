import { Module } from '@nestjs/common';
import { SettingsNotesModule } from '../settings-notes/settings-notes.module.js';
import { Definitions } from './definitions.js';
import { FileDefinitions } from './file-definitions.js';

/** The definitions runtime code reads: `Definitions`, from the notes. */
@Module({
  imports: [SettingsNotesModule],
  providers: [{ provide: Definitions, useClass: FileDefinitions }],
  exports: [Definitions, SettingsNotesModule],
})
export class DefinitionsModule {}
