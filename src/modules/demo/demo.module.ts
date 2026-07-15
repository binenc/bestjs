import { Module } from '@nestjs/common';
import { PasswordService } from '../../core/security/password.service';
import { AdminController } from './admin.controller';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({
  controllers: [DemoController, AdminController],
  providers: [DemoService, PasswordService],
})
export class DemoModule {}
