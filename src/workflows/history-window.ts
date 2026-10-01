import type { EntityManager } from 'typeorm';
import { renderHistoryInput } from '../history/history-input.js';
import type { MessageHistory } from '../history/message-history.service.js';
import { WorkflowRun } from '../persistence/entities/workflow-run.entity.js';
import type { ResolvedWorkflow } from '../settings-files/snapshot.js';
import {
  type HistoryRead,
  type HistoryWindowSnapshot,
  historyWindowSchema,
} from './execution-snapshot.js';

/** How far back a Workflow's first run reads when it has no earlier window. */
export const FIRST_WINDOW_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** What a run being claimed reads its history window with. */
export interface HistoryWindowRequest {
  /** The run's Workflow: its history input and its input template. */
  workflow: Pick<ResolvedWorkflow, 'name' | 'history' | 'resolved' | 'input'>;
  /** The window a retry inherits from the run it retries, if any. */
  inherited: unknown;
  /** When the run is claimed. */
  now: Date;
  /** The installation's time zone, for the transcript. */
  timeZone: string;
}

/**
 * Fixes the history window of a run being claimed, inside the claim's
 * transaction, and renders its input. A retry keeps the window of the run
 * it retries. Otherwise the window ends at the latest message and starts
 * after the previous completed run's window, or a fixed number of hours
 * back (24 for a first run). Null when the run reads no history.
 */
export async function readHistoryWindow(
  manager: EntityManager,
  history: MessageHistory,
  request: HistoryWindowRequest,
): Promise<{ input: string; read: HistoryRead } | null> {
  const inherited = historyWindowSchema.safeParse(request.inherited);
  let window: HistoryWindowSnapshot;
  if (inherited.success) {
    window = inherited.data;
  } else if (request.workflow.history === null) {
    return null;
  } else {
    const { history: config, resolved, name } = request.workflow;
    const untilId = await history.latestIdWithin(manager);
    const afterId =
      config.hours === null ? await previousWindowEnd(manager, name) : null;
    const hours = config.hours ?? FIRST_WINDOW_HOURS;
    window = {
      channels: resolved.history === 'all' ? 'all' : [...resolved.history],
      messages: config.messages,
      runWhenEmpty: config.runWhenEmpty,
      afterId,
      since:
        afterId === null
          ? new Date(request.now.getTime() - hours * HOUR_MS).toISOString()
          : null,
      untilId,
    };
  }
  const messages = await history.windowWithin(manager, window);
  const { input, dropped } = renderHistoryInput(
    request.workflow.input,
    messages.map((message) => ({
      // The foreign key guarantees the Channel.
      channel: message.channel!.title ?? message.channel!.externalKey,
      speaker:
        message.origin === 'user' ? 'User' : (message.agentName ?? 'Agent'),
      text: message.text,
      createdAt: message.createdAt,
    })),
    request.timeZone,
  );
  return { input, read: { ...window, count: messages.length, dropped } };
}

/**
 * Where the Workflow's latest completed window ended; null when none of
 * its completed runs read history. Runs that failed, were cancelled, or
 * were interrupted leave their window for the next run to read.
 */
async function previousWindowEnd(
  manager: EntityManager,
  workflowName: string,
): Promise<number | null> {
  const row = await manager
    .getRepository(WorkflowRun)
    .createQueryBuilder('run')
    .select(
      `MAX(json_extract(run.executionConfig, '$.history.untilId'))`,
      'untilId',
    )
    .where('run.workflowName = :workflowName', { workflowName })
    .andWhere('run.status = :status', { status: 'completed' })
    .getRawOne<{ untilId: number | null }>();
  const untilId = row?.untilId ?? null;
  return untilId === null ? null : Number(untilId);
}
