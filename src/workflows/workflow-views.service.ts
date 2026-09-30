import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, In } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import type { WorkflowChannelView, WorkflowView } from '../control/protocol.js';
import {
  type AgentDefinition,
  Definitions,
  type WorkflowDefinition,
} from '../definitions/definitions.js';
import { Channel } from '../persistence/entities/channel.entity.js';
import { inTransaction } from '../persistence/transaction.js';
import {
  type ScheduleTimes,
  scheduleStatesWithin,
  stateOf,
} from '../scheduler/schedule-state.js';
import { SettingsNotes } from '../settings-notes/settings-notes.service.js';
import { findWorkflowNote, shownPath } from '../settings-files/note-hints.js';

/**
 * Workflows as the CLI shows them: their note, their Agent, when they run
 * next, and the Channels they name.
 */
@Injectable()
export class WorkflowViews {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly definitions: Definitions,
    private readonly notes: SettingsNotes,
  ) {}

  /** Every Workflow, by name. */
  list(): Promise<WorkflowView[]> {
    return this.views(() => this.definitions.workflows());
  }

  /**
   * The Workflow named `name`; `NotFoundError` if none, naming its note
   * when that has errors and never loaded.
   */
  async details(name: string): Promise<WorkflowView> {
    const [view] = await this.views(async () => {
      const workflow = await this.definitions.workflow(name);
      if (workflow === null) throw missingWorkflow(this.notes, name);
      return [workflow];
    });
    return view!;
  }

  private async views(
    read: () => Promise<WorkflowDefinition[]>,
  ): Promise<WorkflowView[]> {
    const workflows = await read();
    const agents = new Map(
      (await this.definitions.agents()).map((agent) => [agent.name, agent]),
    );
    return inTransaction(this.dataSource, async (manager) => {
      const ids = new Set(
        workflows.flatMap((workflow) => [
          ...workflow.targets,
          ...(workflow.history === null || workflow.history.channels === 'all'
            ? []
            : workflow.history.channels),
        ]),
      );
      const channels = new Map(
        (await manager.getRepository(Channel).findBy({ id: In([...ids]) })).map(
          (channel) => [channel.id, channelView(channel)],
        ),
      );
      const states = await scheduleStatesWithin(
        manager,
        workflows.length === 1 ? workflows[0]!.name : undefined,
      );
      return workflows.map((workflow) =>
        this.view(
          workflow,
          agents.get(workflow.agent) ?? null,
          channels,
          states,
        ),
      );
    });
  }

  private view(
    workflow: WorkflowDefinition,
    agent: AgentDefinition | null,
    channels: ReadonlyMap<number, WorkflowChannelView>,
    states: ReadonlyMap<string, ScheduleTimes>,
  ): WorkflowView {
    const named = (ids: readonly number[]) =>
      ids.flatMap((id) => {
        const channel = channels.get(id);
        return channel === undefined ? [] : [channel];
      });
    const { history } = workflow;
    return {
      name: workflow.name,
      title: workflow.title,
      ...this.note(workflow.name),
      agent: workflow.agent,
      agentEnabled: agent?.enabled ?? false,
      inputTemplate: workflow.input,
      enabled: workflow.enabled,
      maxAttempts: workflow.maxAttempts,
      schedules: workflow.schedules.map((schedule) => {
        const times = stateOf(states, workflow.name, schedule);
        return {
          cron: schedule.cron,
          timezone: schedule.timezone,
          nextRunAt: times?.nextRunAt?.toISOString() ?? null,
          lastRunAt: times?.lastRunAt?.toISOString() ?? null,
        };
      }),
      channels: named(workflow.targets),
      history:
        history === null
          ? null
          : {
              channels:
                history.channels === 'all' ? 'all' : named(history.channels),
              messages: history.messages,
              hours: history.hours,
              runWhenEmpty: history.runWhenEmpty,
            },
    };
  }

  /** The note of the Workflow named `name`, and its errors. */
  private note(name: string): Pick<WorkflowView, 'file' | 'errors'> {
    const snapshot = this.notes.snapshot();
    const folders = this.notes.folders();
    const note = snapshot?.workflows.get(name);
    if (snapshot === null || folders === null || note === undefined) {
      return { file: null, errors: [] };
    }
    return {
      file: shownPath(
        folders.workspace,
        join(folders.settingsFolder, note.file),
      ),
      errors: snapshot.errors
        .filter((error) => error.file === note.file)
        .map(({ property, message }) => ({ property, message })),
    };
  }
}

/**
 * Why there is no Workflow named `name`: its note has errors and never
 * loaded, or there is no such note.
 */
export function missingWorkflow(
  notes: SettingsNotes,
  name: string,
): NotFoundError {
  const snapshot = notes.snapshot();
  const folders = notes.folders();
  if (snapshot !== null && folders !== null) {
    const broken = findWorkflowNote(
      snapshot.errors.map((error) => error.file),
      name,
    );
    if (broken !== null) {
      const file = shownPath(
        folders.workspace,
        join(folders.settingsFolder, broken),
      );
      return new NotFoundError(
        `Workflow ${name} isn't loaded: ${file} has errors; pero check lists them`,
      );
    }
  }
  return new NotFoundError(`No Workflow named ${name}`);
}

function channelView(channel: Channel): WorkflowChannelView {
  return {
    id: channel.id,
    integrationKind: channel.integrationKind,
    key: channel.externalKey,
    title: channel.title,
  };
}
