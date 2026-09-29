import { CreateSettings1790521767275 } from './1790521767275-CreateSettings.js';
import { CreateDomainTables1790523956072 } from './1790523956072-CreateDomainTables.js';
import { ResumeSessionsByProviderAndFolder1790578903382 } from './1790578903382-ResumeSessionsByProviderAndFolder.js';
import { AllowedChatsAndChannelTitles1790581676882 } from './1790581676882-AllowedChatsAndChannelTitles.js';
import { CreateMessageHistory1790590513558 } from './1790590513558-CreateMessageHistory.js';
import { DefaultPermissions1790602942841 } from './1790602942841-DefaultPermissions.js';
import { RunSkippedCount1790620569391 } from './1790620569391-RunSkippedCount.js';
import { WorkflowMaxAttempts1790621795251 } from './1790621795251-WorkflowMaxAttempts.js';
import { WorkflowHistory1790623147117 } from './1790623147117-WorkflowHistory.js';
import { NotificationDelivery1790658397489 } from './1790658397489-NotificationDelivery.js';
import { HistoryRetention1790680000000 } from './1790680000000-HistoryRetention.js';

/**
 * Every migration in the order it runs, listed explicitly so the compiled
 * package ships them without file globbing. Append new migrations here.
 */
export const MIGRATIONS = [
  CreateSettings1790521767275,
  CreateDomainTables1790523956072,
  ResumeSessionsByProviderAndFolder1790578903382,
  AllowedChatsAndChannelTitles1790581676882,
  CreateMessageHistory1790590513558,
  DefaultPermissions1790602942841,
  RunSkippedCount1790620569391,
  WorkflowMaxAttempts1790621795251,
  WorkflowHistory1790623147117,
  NotificationDelivery1790658397489,
  HistoryRetention1790680000000,
];
