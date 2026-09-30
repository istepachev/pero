import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import { Agent } from '../persistence/entities/agent.entity.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';

/**
 * Between the IDs some state still refers to definitions by and their
 * names. `Definitions` knows names only. Channels keep their Agent's ID
 * until plan step 8.2, and Triggers their Workflow's until 9.4; this goes
 * once nothing needs it.
 */
@Injectable()
export class DefinitionIds {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** The name of the Agent with row ID `id`; `NotFoundError` if none. */
  async agentName(id: number): Promise<string> {
    const row = await this.dataSource
      .getRepository(Agent)
      .findOne({ select: { name: true }, where: { id } });
    if (row === null) throw new NotFoundError(`No Agent with ID ${id}`);
    return row.name;
  }

  /** The row ID of the Agent named `name`, in any case; `NotFoundError` if none. */
  async agentId(name: string): Promise<number> {
    const row = await this.dataSource
      .getRepository(Agent)
      .findOne({ select: { id: true }, where: { name: name.toLowerCase() } });
    if (row === null) throw new NotFoundError(`No Agent named ${name}`);
    return row.id;
  }

  /** Every Agent's name, by row ID. */
  async agentNames(): Promise<Map<number, string>> {
    const rows = await this.dataSource
      .getRepository(Agent)
      .find({ select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * The row ID of the Workflow named `name`, in any case; `NotFoundError`
   * if none.
   */
  async workflowId(name: string): Promise<number> {
    const row = await this.dataSource
      .getRepository(Workflow)
      .findOne({ select: { id: true }, where: { name: name.toLowerCase() } });
    if (row === null) throw new NotFoundError(`No Workflow named ${name}`);
    return row.id;
  }

  /** Every Workflow's name, by row ID. */
  async workflowNames(): Promise<Map<number, string>> {
    const rows = await this.dataSource
      .getRepository(Workflow)
      .find({ select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
