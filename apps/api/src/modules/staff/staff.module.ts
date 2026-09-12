import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  // AuthModule provides SessionService: deactivating or changing the role of a
  // staff member must revoke their live sessions.
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
