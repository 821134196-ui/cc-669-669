import { Controller, Get, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AllocationService } from '../allocation/allocation.service';

@Controller('allocations')
export class AllocationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: AllocationService,
  ) {}

  @Get()
  list() {
    return this.prisma.allocation.findMany({
      include: { order: true, batch: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** 客户确认取货 */
  @Post(':id/pickup')
  pickup(@Param('id') id: string) {
    return this.allocation.pickup(id);
  }

  /** 客户拒收：库存退回原批次，订单取消，通知下一顺位 */
  @Post(':id/reject')
  reject(@Param('id') id: string) {
    return this.allocation.closeAllocation(id, 'REJECTED');
  }

  /** 客户放弃本批次：库存退回原批次，订单保留后续排队资格 */
  @Post(':id/give-up')
  giveUp(@Param('id') id: string) {
    return this.allocation.closeAllocation(id, 'GIVEN_UP');
  }

  /** 手动触发一次逾期扫描（定时器之外的管理入口） */
  @Post('sweep-expired')
  async sweep() {
    return { swept: await this.allocation.sweepExpired() };
  }
}
