import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module.js';
import { SpeechService } from './speech.service.js';

/**
 * Speech: transcribing voice messages and recording Pero's own, with the
 * engines `config.yaml` names.
 */
@Module({
  imports: [HealthModule],
  providers: [SpeechService],
  exports: [SpeechService],
})
export class SpeechModule {}
