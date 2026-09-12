import { Global, Module } from '@nestjs/common';
import { databaseProviders, DatabaseService } from './database.service';

/**
 * Global because nearly every module needs it, and threading an import through
 * every feature module buys nothing.
 */
@Global()
@Module({
  providers: databaseProviders,
  exports: [DatabaseService],
})
export class DatabaseModule {}
