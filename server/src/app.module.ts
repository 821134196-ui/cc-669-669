import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { NotificationService } from './notification.service';
import { AllocationService } from './allocation/allocation.service';
import { ExpirySweeper } from './allocation/expiry.sweeper';
import { ProductsController } from './http/products.controller';
import { BatchesController } from './http/batches.controller';
import { OrdersController } from './http/orders.controller';
import { AllocationsController } from './http/allocations.controller';
import { NotificationsController } from './http/notifications.controller';

@Module({
  controllers: [
    ProductsController,
    BatchesController,
    OrdersController,
    AllocationsController,
    NotificationsController,
  ],
  providers: [PrismaService, NotificationService, AllocationService, ExpirySweeper],
})
export class AppModule {}
