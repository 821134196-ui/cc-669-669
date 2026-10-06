import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { NotificationService } from '../notification.service';
import { AllocationService } from '../allocation/allocation.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly allocation: AllocationService,
  ) {}

  /**
   * 创建预订订单（本地模拟支付：创建即视为支付成功）。
   * paidAt 可选，仅用于演示/测试"同一时间付款按订单号排序"的场景。
   */
  @Post()
  async create(@Body() body: { productId?: string; customer?: string; orderNo?: string; paidAt?: string }) {
    const productId = body?.productId ?? '';
    const customer = body?.customer?.trim();
    if (!productId || !customer) throw new BadRequestException('productId 和 customer 必填');
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('商品不存在');

    let paidAt = new Date();
    if (body?.paidAt) {
      paidAt = new Date(body.paidAt);
      if (Number.isNaN(paidAt.getTime())) throw new BadRequestException('paidAt 格式非法');
    }

    const orderNo = body?.orderNo?.trim() || this.genOrderNo();
    let order;
    try {
      order = await this.prisma.order.create({
        data: { orderNo, productId, customer, paidAt },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new BadRequestException(`订单号 ${orderNo} 已存在`);
      throw e;
    }

    await this.notify.send('PAYMENT_SUCCESS', order.id, {
      orderNo: order.orderNo,
      customer: order.customer,
      paidAt: order.paidAt,
      message: '支付成功（模拟），已进入预订排队',
    });

    // 新订单进入队列后，尝试用现有可分配库存立即分配
    await this.allocation.allocateProduct(productId);
    return this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  }

  /** 订单列表（含排队顺位），可按商品过滤 */
  @Get()
  async list(@Query('productId') productId?: string) {
    const orders = await this.prisma.order.findMany({
      where: productId ? { productId } : undefined,
      include: { product: true },
      orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
    });
    // 计算每个 QUEUED 订单在同商品队列中的顺位
    const positions = new Map<string, number>();
    const byProduct = new Map<string, typeof orders>();
    for (const o of orders) {
      if (o.status !== 'QUEUED') continue;
      const arr = byProduct.get(o.productId) ?? [];
      arr.push(o);
      byProduct.set(o.productId, arr);
    }
    for (const arr of byProduct.values()) {
      arr.forEach((o, i) => positions.set(o.id, i + 1));
    }
    return orders.map((o) => ({ ...o, position: positions.get(o.id) ?? null }));
  }

  /** 客户查询：顺位、当前分配（批次+取货期限）、已放弃批次、历史分配 */
  @Get(':orderNo')
  async detail(@Param('orderNo') orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: {
        product: true,
        allocations: { include: { batch: true }, orderBy: { createdAt: 'desc' } },
        skips: { include: { batch: true } },
      },
    });
    if (!order) throw new NotFoundException(`订单 ${orderNo} 不存在`);

    let position: number | null = null;
    if (order.status === 'QUEUED') {
      const ahead = await this.prisma.order.count({
        where: {
          productId: order.productId,
          status: 'QUEUED',
          OR: [
            { paidAt: { lt: order.paidAt } },
            { paidAt: order.paidAt, orderNo: { lt: order.orderNo } },
          ],
        },
      });
      position = ahead + 1;
    }

    const currentAllocation = order.allocations.find((a) => a.status === 'PENDING_PICKUP') ?? null;
    return {
      order,
      position,
      currentAllocation,
      skippedBatches: order.skips.map((s) => ({ batchNo: s.batch.batchNo, at: s.createdAt })),
    };
  }

  private genOrderNo() {
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `O${Date.now()}${rand}`;
  }
}
