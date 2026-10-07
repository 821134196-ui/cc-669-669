import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LockService } from '../common/lock.service';
import { NotificationService } from '../common/notification.service';
import { PaymentService } from '../common/payment.service';
import { AllocationController } from './allocation.controller';
import { AllocationEngine } from './allocation.engine';
import { ExpireScheduler } from './expire.scheduler';

@Module({
  controllers: [AllocationController],
  providers: [
    PrismaService,
    LockService,
    NotificationService,
    PaymentService,
    AllocationEngine,
    ExpireScheduler,
  ],
})
export class AllocationModule {}
