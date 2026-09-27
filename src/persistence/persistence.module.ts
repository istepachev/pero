import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';
import { dataSourceOptions } from './data-source-options.js';
import { openDatabase } from './open-database.js';

export interface PersistenceOptions {
  /** Path of the SQLite database file. */
  database: string;
}

/**
 * The SQLite database. The `DataSource` provider resolves only after
 * migrations have run, so nothing that injects it can touch the database
 * before the schema is current.
 */
@Module({})
export class PersistenceModule {
  static forRoot(options: PersistenceOptions): DynamicModule {
    return {
      module: PersistenceModule,
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            ...dataSourceOptions(options.database),
            // A failed open or migration fails startup at once; the Nest
            // default retries for about half a minute.
            toRetry: () => false,
          }),
          dataSourceFactory: (typeOrmOptions?: DataSourceOptions) =>
            openDatabase(typeOrmOptions!),
        }),
      ],
    };
  }
}
