import { Module } from '@nestjs/common';

/**
 * Root module for the `pero` executable. Import only what commands need;
 * never the daemon `AppModule`.
 */
@Module({})
export class CliModule {}
