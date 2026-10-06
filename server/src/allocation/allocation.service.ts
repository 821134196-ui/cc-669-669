import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NotificationService } from '../notification.service';

/**
 * 分配引擎。核心不变量：
 *  1. 批次 allocatedQty 永不超过 receivedQty —— 通过条件更新
 *     `UPDATE ... SET allocatedQty = allocatedQty + 1 WHERE allocatedQty < receivedQty`
 *     原子占位（count=0 即批次已满），并发下也不会超卖。
 *  2. 同一订单最多持有一条进行中的分配 —— 通过条件更新
 *     `UPDATE Order SET status=ALLOCATED WHERE status=QUEUED` 原子锁定。
 *  3. 分配顺序只由 (paidAt, orderNo) 决定，没有任何人工插队入口。
 *  4. 分配关闭（逾期/拒收/放弃）时 allocatedQty 减一，库存退回原批次，
 *     并立即从该批次继续通知下一顺位。
 */
@Injectable()
export class AllocationService {
  private readonly pickupWindowMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
  ) {
    this.pickupWindowMs = Number(process.env.PICKUP_WINDOW_SECONDS ?? 1800) * 1000;
  }

  // ---------------------------------------------------------------- 到货登记

  /**
   * 登记实收到货批次。receiptId 是到货回执幂等键：
   * 重复回执（包括并发重复提交）只返回已有批次，绝不重复增加库存。
   */
  async registerBatch(input: {
    productId: string;
    receivedQty: number;
    receiptId: string;
    batchNo?: string;
  }) {
    const { productId, receivedQty, receiptId } = input;
    if (!productId) throw new BadRequestException('productId 必填');
    if (!receiptId) throw new BadRequestException('receiptId（到货回执号）必填');
    if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
      throw new BadRequestException('receivedQty 必须为正整数');
    }
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('商品不存在');

    const existing = await this.prisma.batch.findUnique({ where: { receiptId } });
    if (existing) {
      return { batch: existing, duplicated: true as const };
    }

    let batch;
    try {
      batch = await this.prisma.batch.create({
        data: {
          productId,
          receiptId,
          receivedQty,
          batchNo: input.batchNo?.trim() || `B-${Date.now().toString(36).toUpperCase()}`,
        },
      });
    } catch (e: any) {
      // 并发下两条相同回执同时落库：唯一约束兜底，后到的请求返回已存在的批次
      if (e?.code === 'P2002') {
        const dup = await this.prisma.batch.findUnique({ where: { receiptId } });
        if (dup) return { batch: dup, duplicated: true as const };
      }
      throw e;
    }

    await this.allocateBatch(batch.id);
    return { batch, duplicated: false as const };
  }

  // ---------------------------------------------------------------- 分配

  /** 对某商品所有可分配批次（按到货先后）执行分配 */
  async allocateProduct(productId: string) {
    const batches = await this.prisma.batch.findMany({
      where: { productId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    let total = 0;
    for (const b of batches) {
      if (b.allocatedQty < b.receivedQty) {
        total += await this.allocateBatch(b.id);
      }
    }
    return total;
  }

  /**
   * 从单个批次向队首订单分配，直到批次分完或队列清空。
   * 每一步都是一个短事务：读候选 → 原子占库存 → 原子锁订单 → 建分配记录。
   */
  async allocateBatch(batchId: string): Promise<number> {
    let allocated = 0;
    for (;;) {
      const result = await this.prisma.$transaction(async (tx) => {
        const batch = await tx.batch.findUnique({ where: { id: batchId } });
        // 质检暂停 / 不存在 / 已分完 → 停止
        if (!batch || batch.status !== 'ACTIVE' || batch.allocatedQty >= batch.receivedQty) {
          return { stop: true as const };
        }
        // 队首：付款时间升序，同时间按订单号稳定排序；跳过"已放弃本批次"的订单
        const order = await tx.order.findFirst({
          where: {
            productId: batch.productId,
            status: 'QUEUED',
            skips: { none: { batchId } },
          },
          orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
        });
        if (!order) return { stop: true as const };

        // 原子占位：仅当仍有剩余时才 +1，并发安全
        const claim = await tx.batch.updateMany({
          where: { id: batchId, status: 'ACTIVE', allocatedQty: { lt: batch.receivedQty } },
          data: { allocatedQty: { increment: 1 } },
        });
        if (claim.count === 0) return { stop: true as const };

        // 原子锁单：订单可能刚被另一笔分配锁定
        const lock = await tx.order.updateMany({
          where: { id: order.id, status: 'QUEUED' },
          data: { status: 'ALLOCATED' },
        });
        if (lock.count === 0) {
          await tx.batch.update({ where: { id: batchId }, data: { allocatedQty: { decrement: 1 } } });
          return { stop: false as const }; // 换下一个候选重试
        }

        const deadline = new Date(Date.now() + this.pickupWindowMs);
        const allocation = await tx.allocation.create({
          data: { batchId, orderId: order.id, deadline },
        });
        return { stop: false as const, allocation, order, batch };
      }, { maxWait: 15000, timeout: 15000 });

      if (result.stop) break;
      if ('allocation' in result && result.allocation) {
        allocated += 1;
        await this.notify.send('ALLOCATED', result.order.id, {
          orderNo: result.order.orderNo,
          customer: result.order.customer,
          batchNo: result.batch.batchNo,
          deadline: result.allocation.deadline,
          message: `您预订的商品已分配到批次 ${result.batch.batchNo}，请在取货期限前取货`,
        });
      }
    }
    return allocated;
  }

  // ---------------------------------------------------------------- 分配关闭

  /** 确认取货：分配完成，订单履约，库存随货出库（不退回批次） */
  async pickup(allocationId: string) {
    const done = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.allocation.updateMany({
        where: { id: allocationId, status: 'PENDING_PICKUP' },
        data: { status: 'PICKED_UP', closedAt: new Date() },
      });
      if (closed.count === 0) throw new ConflictException('该分配已关闭或不存在');
      const alloc = await tx.allocation.findUniqueOrThrow({
        where: { id: allocationId },
        include: { order: true, batch: true },
      });
      await tx.order.update({ where: { id: alloc.orderId }, data: { status: 'FULFILLED' } });
      return alloc;
    }, { maxWait: 15000, timeout: 15000 });
    await this.notify.send('PICKED_UP', done.orderId, {
      orderNo: done.order.orderNo,
      batchNo: done.batch.batchNo,
      message: '取货完成，感谢购买',
    });
    return { ok: true };
  }

  /**
   * 关闭一笔待取货分配并把库存退回原批次，然后立即通知下一顺位。
   *  - EXPIRED  逾期未取 → 订单取消（失去资格）
   *  - REJECTED 拒收     → 订单取消（失去资格）
   *  - GIVEN_UP 放弃本批 → 订单保留排队资格，仅跳过本批次
   */
  async closeAllocation(allocationId: string, action: 'EXPIRED' | 'REJECTED' | 'GIVEN_UP') {
    const ctx = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.allocation.updateMany({
        where: { id: allocationId, status: 'PENDING_PICKUP' },
        data: { status: action, closedAt: new Date() },
      });
      if (closed.count === 0) throw new ConflictException('该分配已关闭或不存在');
      const alloc = await tx.allocation.findUniqueOrThrow({
        where: { id: allocationId },
        include: { order: true, batch: true },
      });
      // 库存退回原批次
      await tx.batch.update({
        where: { id: alloc.batchId },
        data: { allocatedQty: { decrement: 1 } },
      });
      if (action === 'GIVEN_UP') {
        await tx.batchSkip.upsert({
          where: { batchId_orderId: { batchId: alloc.batchId, orderId: alloc.orderId } },
          create: { batchId: alloc.batchId, orderId: alloc.orderId },
          update: {},
        });
        await tx.order.update({ where: { id: alloc.orderId }, data: { status: 'QUEUED' } });
      } else {
        await tx.order.update({ where: { id: alloc.orderId }, data: { status: 'CANCELLED', cancelReason: action } });
      }
      return alloc;
    }, { maxWait: 15000, timeout: 15000 });

    await this.notify.send(action, ctx.orderId, {
      orderNo: ctx.order.orderNo,
      batchNo: ctx.batch.batchNo,
      message:
        action === 'GIVEN_UP'
          ? `您已放弃批次 ${ctx.batch.batchNo}，仍保留后续批次的排队资格`
          : action === 'EXPIRED'
            ? `取货期限已过，批次 ${ctx.batch.batchNo} 的分配已取消`
            : `您已拒收批次 ${ctx.batch.batchNo} 的商品，订单已取消`,
    });

    // 退回的库存立即分给该批次下一顺位
    await this.allocateBatch(ctx.batchId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- 逾期扫描

  /** 扫描并关闭所有逾期的待取货分配（由定时器或手动接口触发） */
  async sweepExpired(now = new Date()) {
    const expired = await this.prisma.allocation.findMany({
      where: { status: 'PENDING_PICKUP', deadline: { lt: now } },
      select: { id: true },
    });
    let swept = 0;
    for (const a of expired) {
      try {
        await this.closeAllocation(a.id, 'EXPIRED');
        swept += 1;
      } catch {
        // 并发下可能已被取货/关闭，忽略
      }
    }
    return swept;
  }

  // ---------------------------------------------------------------- 质检

  async setBatchStatus(batchId: string, status: 'ACTIVE' | 'QC_PAUSED') {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('批次不存在');
    const updated = await this.prisma.batch.update({ where: { id: batchId }, data: { status } });
    if (status === 'ACTIVE') {
      // 恢复后立即补充分配
      await this.allocateBatch(batchId);
    }
    return updated;
  }
}
