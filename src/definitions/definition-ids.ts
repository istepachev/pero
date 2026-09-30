import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { NotFoundError } from '../common/errors.js';
import { Workflow } from '../persistence/entities/workflow.entity.js';

/**
 * Between the IDs Triggers and notification targets still refer to
 * Workflows by and their names. `Definitions` knows names only. This goes
 * with those tables, in plan step 9.4.
 */
@Injectable()
export class DefinitionIds {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
