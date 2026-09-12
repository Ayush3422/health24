import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global: the audit trail is cross-cutting, and a module that has to remember
 * to import it is a module that will forget.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
