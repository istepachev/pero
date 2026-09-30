import { Module } from '@nestjs/common';
import { DefinitionsModule } from '../definitions/definitions.module.js';
import { SettingsService } from './settings.service.js';

@Module({
  imports: [DefinitionsModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
