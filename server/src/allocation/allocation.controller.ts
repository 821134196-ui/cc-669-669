import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AllocationEngine } from './allocation.engine';
import {
  CreateProductDto,
  PlaceOrderDto,
  RegisterBatchDto,
  UpdateBatchDto,
} from './dto';

@Controller('api')
export class AllocationController {
  constructor(
    private readonly engine: AllocationEngine,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------- 商品

  @Get('products')
  listProducts() {
    return this.prisma.product.findMany({ orderBy: { createdAt: 'asc' } });
  }

  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.prisma.product.create({ data: dto });
  }

  // ---------------- 订单 / 客户查询

  /** 模拟支付成功 → 预订订单入队 */
  @Post('orders')
  placeOrder(@Body() dto: PlaceOrderDto) {
    return this.engine.placeOrder(dto.productId, dto.customer, dto.phone);
  }

  @Get('orders/:orderNo')
  getOrder(@Param('orderNo') orderNo: string) {
    return this.engine.getOrderView(orderNo);
  }

  /** 客户：放弃本批次（保留后续排队资格） */
  @Post('allocations/:id/waive')
  waive(@Param('id') id: string) {
    return this.engine.waive(id);
  }

  // ---------------- 运营台

  @Get('products/:id/queue')
  getQueue(@Param('id') id: string) {
    return this.engine.getQueue(id);
  }

  /** 登记实收到货批次（receiptNo 幂等） */
  @Post('batches')
  registerBatch(@Body() dto: RegisterBatchDto) {
    return this.engine.registerReceipt(
      dto.productId,
      dto.batchNo,
      dto.receivedQty,
      dto.receiptNo,
    );
  }

  @Get('batches')
  listBatches(@Query('productId') productId?: string) {
    return this.engine.listBatches(productId);
  }

  /** 质检暂停 / 恢复批次 */
  @Patch('batches/:id')
  updateBatch(@Param('id') id: string, @Body() dto: UpdateBatchDto) {
    return this.engine.setPaused(id, dto.paused);
  }

  @Post('allocations/:id/pickup')
  pickup(@Param('id') id: string) {
    return this.engine.pickup(id);
  }

  @Post('allocations/:id/reject')
  reject(@Param('id') id: string) {
    return this.engine.reject(id);
  }

  /** 运营手动置逾期（演示“逾期自动顺延”，生产中只由定时扫描触发） */
  @Post('allocations/:id/expire')
  expire(@Param('id') id: string) {
    return this.engine.forceExpire(id);
  }

  @Get('notifications')
  async notifications(
    @Query('orderNo') orderNo?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit) || 50, 200);
    const where = orderNo ? { order: { orderNo } } : undefined;
    return this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: { order: { select: { orderNo: true, customer: true } } },
    });
  }
}
