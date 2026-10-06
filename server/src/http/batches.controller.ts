import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AllocationService } from '../allocation/allocation.service';

@Controller('batches')
export class BatchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: AllocationService,
  ) {}

  /** 运营登记实收到货批次（receiptId 幂等） */
  @Post()
  register(@Body() body: { productId?: string; receivedQty?: number; receiptId?: string; batchNo?: string }) {
    return this.allocation.registerBatch({
      productId: body?.productId ?? '',
      receivedQty: Number(body?.receivedQty),
      receiptId: body?.receiptId?.trim() ?? '',
      batchNo: body?.batchNo,
    });
  }

  @Get()
  list() {
    return this.prisma.batch.findMany({
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 质检暂停：暂停后批次不再参与分配 */
  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.allocation.setBatchStatus(id, 'QC_PAUSED');
  }

  /** 质检恢复：恢复后立即对队列补充分配 */
  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.allocation.setBatchStatus(id, 'ACTIVE');
  }
}
