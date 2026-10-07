import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Allocation, Batch, Order, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LockService } from '../common/lock.service';
import { NotificationService, NoticeType } from '../common/notification.service';
import { PaymentService } from '../common/payment.service';

export type SettleKind = 'PICKED_UP' | 'EXPIRED' | 'REJECTED' | 'WAIVED';

interface AssignEvent {
  orderId: string;
  batchId: string;
  position: number;
  attempt: number;
  pickupDueAt: Date;
}

/**
 * 分配引擎。所有改变库存 / 占用状态的入口都按 productId 加产品级互斥锁，
 * 事务内再用条件 UPDATE 兜底，确保并发下 allocatedQty 绝不会超过 receivedQty。
 */
@Injectable()
export class AllocationEngine {
  readonly deadlineHours = Number(process.env.PICKUP_DEADLINE_HOURS ?? 48);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly notifications: NotificationService,
    private readonly payments: PaymentService,
  ) {}

  // ---------------------------------------------------------------- 下单支付

  /** 模拟支付成功后创建预订订单并进入排队，立即尝试分配 */
  async placeOrder(productId: string, customer: string, phone: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('商品不存在');

    const pay = await this.payments.pay();
    return this.locks.run(this.key(productId), async () => {
      const order = await this.prisma.order.create({
        data: {
          orderNo: this.genOrderNo(),
          productId,
          customer,
          phone,
          paidAt: pay.paidAt,
          inQueue: true,
        },
      });
      const events = await this.$reassign(productId);
      await this.$notifyAssigned(events);
      return this.getOrderView(order.orderNo);
    });
  }

  // ---------------------------------------------------------------- 到货登记

  /**
   * 登记实收到货批次。receiptNo（到货回执单号）唯一：
   * 重复回执直接返回原批次，不会再次增加库存。
   */
  async registerReceipt(productId: string, batchNo: string, receivedQty: number, receiptNo: string) {
    if (!Number.isInteger(receivedQty) || receivedQty <= 0) {
      throw new BadRequestException('实收数量必须为正整数');
    }
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('商品不存在');

    return this.locks.run(this.key(productId), async () => {
      // 先查重，唯一约束再兜底（并发双发）
      const dup = await this.prisma.batch.findUnique({ where: { receiptNo } });
      if (dup) {
        return { batch: dup, duplicated: true };
      }
      let batch: Batch;
      try {
        batch = await this.prisma.batch.create({
          data: { productId, batchNo, receivedQty, receiptNo, paused: false },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const existing = await this.prisma.batch.findUnique({ where: { receiptNo } });
          return { batch: existing!, duplicated: true };
        }
        throw e;
      }
      const events = await this.$reassign(productId);
      await this.$notifyAssigned(events);
      return { batch, duplicated: false };
    });
  }

  // ---------------------------------------------------------------- 暂停/恢复

  async setPaused(batchId: string, paused: boolean) {
    const batch = await this.prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('批次不存在');
    return this.locks.run(this.key(batch.productId), async () => {
      const updated = await this.prisma.batch.update({ where: { id: batchId }, data: { paused } });
      if (!paused) {
        // 恢复质检：该批次重新具备分配资格，立即补排
        const events = await this.$reassign(batch.productId);
        await this.$notifyAssigned(events);
      }
      return updated;
    });
  }

  // ---------------------------------------------------------------- 取货 / 拒收 / 放弃 / 逾期

  async pickup(allocationId: string) {
    return this.settle(allocationId, 'PICKED_UP');
  }

  async reject(allocationId: string) {
    return this.settle(allocationId, 'REJECTED');
  }

  async waive(allocationId: string) {
    return this.settle(allocationId, 'WAIVED');
  }

  /** 手工把某笔待取货置为逾期（演示用；正常由定时扫描触发） */
  async forceExpire(allocationId: string) {
    return this.settle(allocationId, 'EXPIRED');
  }

  private async settle(allocationId: string, kind: SettleKind) {
    const alloc = await this.prisma.allocation.findUnique({
      where: { id: allocationId },
      include: { batch: true, order: true },
    });
    if (!alloc) throw new NotFoundException('分配记录不存在');
    if (alloc.status !== 'ASSIGNED') {
      throw new ConflictException(`该分配当前状态为 ${alloc.status}，不能执行此操作`);
    }
    if (kind === 'PICKED_UP' && alloc.pickupDueAt.getTime() <= Date.now()) {
      throw new ConflictException('已超过取货期限，不能取货');
    }

    return this.locks.run(this.key(alloc.batch.productId), async () => {
      const events = await this.prisma.$transaction(async (tx) => {
        // 条件更新状态，防止并发下重复结算
        const claimed = await tx.allocation.updateMany({
          where: { id: allocationId, status: 'ASSIGNED' },
          data: { status: kind, settledAt: new Date(), releasedFromBatch: kind !== 'PICKED_UP' },
        });
        if (claimed.count !== 1) throw new ConflictException('分配状态已变化，请刷新后重试');

        if (kind === 'PICKED_UP') {
          // 商品实际交付：实收与占用同时减 1，可分余量不变
          const r = await tx.$executeRaw`
            UPDATE Batch SET receivedQty = receivedQty - 1, allocatedQty = allocatedQty - 1
            WHERE id = ${alloc.batchId} AND allocatedQty >= 1`;
          if (r !== 1) throw new ConflictException('批次库存异常，取货失败');
          await tx.order.update({ where: { id: alloc.orderId }, data: { inQueue: false } });
          return [] as AssignEvent[];
        }

        // 逾期 / 拒收 / 放弃：商品退回原批次，占用减 1，可分余量 +1
        const r = await tx.$executeRaw`
          UPDATE Batch SET allocatedQty = allocatedQty - 1
          WHERE id = ${alloc.batchId} AND allocatedQty >= 1`;
        if (r !== 1) throw new ConflictException('批次库存异常，归还失败');
        // 订单保留排队资格（inQueue 保持 true），立刻补排下一顺位
        return this.$reassignTx(tx, alloc.batch.productId);
      });

      await this.notifications.send(
        alloc.orderId,
        kind,
        this.settleNotice(kind, alloc.batch.batchNo, alloc.order.customer),
      );
      await this.$notifyAssigned(events);
      return this.getOrderView(alloc.order.orderNo);
    });
  }

  /** 定时扫描：所有超过取货期限仍未取货的分配，逾期退回并补排 */
  async expireDue() {
    const due = await this.prisma.allocation.findMany({
      where: { status: 'ASSIGNED', pickupDueAt: { lte: new Date() } },
      include: { batch: true, order: true },
    });
    const productIds = [...new Set(due.map((d) => d.batch.productId))];
    const expired: Allocation[] = [];
    for (const productId of productIds) {
      await this.locks.run(this.key(productId), async () => {
        const ids = due.filter((d) => d.batch.productId === productId).map((d) => d.id);
        const events = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.allocation.findMany({
            where: { id: { in: ids }, status: 'ASSIGNED', pickupDueAt: { lte: new Date() } },
          });
          for (const row of rows) {
            await tx.allocation.update({
              where: { id: row.id },
              data: { status: 'EXPIRED', settledAt: new Date(), releasedFromBatch: true },
            });
            await tx.$executeRaw`
              UPDATE Batch SET allocatedQty = allocatedQty - 1
              WHERE id = ${row.batchId} AND allocatedQty >= 1`;
          }
          expired.push(...rows);
          return this.$reassignTx(tx, productId);
        });
        for (const row of expired.filter((e) => ids.includes(e.id))) {
          const full = due.find((d) => d.id === row.id)!;
          await this.notifications.send(
            row.orderId,
            'EXPIRED',
            this.settleNotice('EXPIRED', full.batch.batchNo, full.order.customer),
          );
        }        await this.$notifyAssigned(events);
      });
    }
    return { expiredCount: expired.length };
  }

  // ---------------------------------------------------------------- 核心：重排

  /**
   * 事务内按队列重算分配：
   * - 队列顺序 = paidAt ASC, orderNo ASC（稳定排序，无人能插队）
   * - 只取“仍在排队且当前没有待取货占用”的订单
   * - 跳过质检暂停的批次
   * - 跳过该订单曾放弃/逾期/拒收而退回的批次（不会立刻又分回同一批）
   * - 批次 allocatedQty 用条件 UPDATE 增加，超额则整事务回滚
   */
  private $reassign(productId: string) {
    return this.prisma.$transaction((tx) => this.$reassignTx(tx, productId));
  }

  private async $reassignTx(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<AssignEvent[]> {
    const batches = await tx.batch.findMany({
      where: { productId, paused: false },
      orderBy: [{ arrivedAt: 'asc' }, { id: 'asc' }],
    });
    const orders = await tx.order.findMany({
      where: {
        productId,
        inQueue: true,
        allocations: { none: { status: 'ASSIGNED' } },
      },
      orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
      include: {
        // 取全部历史分配：attempt 按总数计；其中退回过的批次用于排除
        allocations: { select: { batchId: true, releasedFromBatch: true } },
      },
    });
    if (!batches.length || !orders.length) return [];

    const remaining = new Map<string, number>(
      batches.map((b) => [b.id, b.receivedQty - b.allocatedQty]),
    );

    type Plan = { order: (typeof orders)[number]; batch: Batch; position: number; attempt: number };
    const plan: Plan[] = [];

    // 注意：不能因队首暂时无批可分就 break——
    // 队首可能排除了某批次，而后面的订单并不排除，仍可被服务。
    orders.forEach((order, i) => {
      const excluded = new Set(
        order.allocations.filter((a) => a.releasedFromBatch).map((a) => a.batchId),
      );
      const target = batches.find(
        (b) => !excluded.has(b.id) && (remaining.get(b.id) ?? 0) > 0,
      );
      if (!target) return;
      remaining.set(target.id, (remaining.get(target.id) ?? 0) - 1);
      plan.push({ order, batch: target, position: i + 1, attempt: order.allocations.length + 1 });
    });

    if (!plan.length) return [];

    // 每个批次一条条件扣减：库存不足 / 批次被暂停都会让改动行数为 0 → 回滚
    const needByBatch = new Map<string, number>();
    for (const p of plan) needByBatch.set(p.batch.id, (needByBatch.get(p.batch.id) ?? 0) + 1);
    for (const [batchId, n] of needByBatch) {
      const changed = await tx.$executeRaw`
        UPDATE Batch
        SET allocatedQty = allocatedQty + ${n}
        WHERE id = ${batchId}
          AND paused = 0
          AND allocatedQty + ${n} <= receivedQty`;
      if (changed !== 1) throw new ConflictException('并发分配冲突：库存不足，本次分配回滚');
    }

    const now = Date.now();
    const due = new Date(now + this.deadlineHours * 3600_000);
    // 逐条创建（SQLite + Prisma 对 createMany 的兼容更稳妥，单次分配量也很小）
    for (const p of plan) {
      await tx.allocation.create({
        data: {
          orderId: p.order.id,
          batchId: p.batch.id,
          queuePosition: p.position,
          attempt: p.attempt,
          status: 'ASSIGNED',
          pickupDueAt: due,
        },
      });
    }

    return plan.map((p) => ({
      orderId: p.order.id,
      batchId: p.batch.id,
      position: p.position,
      attempt: p.attempt,
      pickupDueAt: due,
    }));
  }

  // ---------------------------------------------------------------- 查询视图

  /** 客户视角：顺位 / 批次 / 取货期限 / 放弃后的状态 */
  async getOrderView(orderNo: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNo },
      include: {
        product: true,
        allocations: {
          orderBy: [{ assignedAt: 'desc' }],
          include: { batch: true },
        },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');

    const active = order.allocations.find((a) => a.status === 'ASSIGNED') ?? null;
    const waitingList = await this.prisma.order.findMany({
      where: {
        productId: order.productId,
        inQueue: true,
        allocations: { none: { status: 'ASSIGNED' } },
      },
      orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
      select: { id: true },
    });
    const queueIndex = waitingList.findIndex((o) => o.id === order.id);

    const last = order.allocations[0];
    let state: 'WAITING' | 'ASSIGNED' | 'WAITING_AFTER_RELEASE' | 'DONE';
    if (active) state = 'ASSIGNED';
    else if (!order.inQueue) state = 'DONE';
    else if (last && ['WAIVED', 'EXPIRED', 'REJECTED'].includes(last.status))
      state = 'WAITING_AFTER_RELEASE';
    else state = 'WAITING';

    return {
      orderNo: order.orderNo,
      customer: order.customer,
      phone: order.phone,
      paidAt: order.paidAt,
      inQueue: order.inQueue,
      state,
      stateText: STATE_TEXT[state],
      product: { id: order.product.id, sku: order.product.sku, name: order.product.name },
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      aheadCount: queueIndex > 0 ? queueIndex : 0,
      waitingTotal: waitingList.length,
      active: active
        ? {
            id: active.id,
            batchNo: active.batch.batchNo,
            attempt: active.attempt,
            queuePosition: active.queuePosition,
            pickupDueAt: active.pickupDueAt,
            assignedAt: active.assignedAt,
            hoursLeft: Math.max(0, Math.round((active.pickupDueAt.getTime() - Date.now()) / 3600_000)),
          }
        : null,
      history: order.allocations.map((a) => ({
        id: a.id,
        batchNo: a.batch.batchNo,
        status: a.status,
        statusText: STATUS_TEXT[a.status as SettleKind | 'ASSIGNED'],
        attempt: a.attempt,
        queuePosition: a.queuePosition,
        assignedAt: a.assignedAt,
        pickupDueAt: a.pickupDueAt,
        settledAt: a.settledAt,
        releasedFromBatch: a.releasedFromBatch,
      })),
    };
  }

  /** 运营视角：某商品的队列 */
  async getQueue(productId: string) {
    const all = await this.prisma.order.findMany({
      where: { productId },
      orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
      include: {
        allocations: {
          orderBy: [{ assignedAt: 'desc' }],
          include: { batch: true },
        },
      },
    });
    const waitingOrder = all
      .filter(
        (o) => o.inQueue && !o.allocations.some((a) => a.status === 'ASSIGNED'),
      )
      .map((o) => o.id);

    return all.map((o) => {
      const active = o.allocations.find((a) => a.status === 'ASSIGNED') ?? null;
      const pos = waitingOrder.indexOf(o.id);
      return {
        id: o.id,
        orderNo: o.orderNo,
        customer: o.customer,
        phone: o.phone,
        paidAt: o.paidAt,
        inQueue: o.inQueue,
        queuePosition: pos >= 0 ? pos + 1 : null,
        active: active
          ? {
              id: active.id,
              batchNo: active.batch.batchNo,
              pickupDueAt: active.pickupDueAt,
              overdue: active.pickupDueAt.getTime() <= Date.now(),
            }
          : null,
        lastStatus: o.allocations[0]?.status ?? null,
      };
    });
  }

  async listBatches(productId?: string) {
    const batches = await this.prisma.batch.findMany({
      where: productId ? { productId } : undefined,
      orderBy: [{ arrivedAt: 'asc' }],
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    return batches.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      product: b.product,
      receivedQty: b.receivedQty,
      allocatedQty: b.allocatedQty,
      remainingQty: b.receivedQty - b.allocatedQty,
      paused: b.paused,
      receiptNo: b.receiptNo,
      arrivedAt: b.arrivedAt,
    }));
  }

  // ---------------------------------------------------------------- 辅助

  private async $notifyAssigned(events: AssignEvent[]) {
    for (const ev of events) {
      const [order, batch] = await Promise.all([
        this.prisma.order.findUniqueOrThrow({ where: { id: ev.orderId } }),
        this.prisma.batch.findUniqueOrThrow({ where: { id: ev.batchId } }),
      ]);
      const due = ev.pickupDueAt.toLocaleString('zh-CN', { hour12: false });
      const type: NoticeType = 'ASSIGNED';
      await this.notifications.send(
        order.id,
        type,
        `您预订的商品已到货（批次 ${batch.batchNo}），排队顺位第 ${ev.position} 位，` +
          `请于 ${due} 前取货，逾期未取将自动顺延给下一顺位客户。`,
      );
    }
  }

  private settleNotice(kind: SettleKind, batchNo: string, _customer: string) {
    switch (kind) {
      case 'PICKED_UP':
        return `批次 ${batchNo} 的商品已取货完成，感谢购买。`;
      case 'EXPIRED':
        return `批次 ${batchNo} 已超过取货期限，商品退回并分配给下一顺位客户；您仍在后续批次的排队队列中。`;
      case 'REJECTED':
        return `您已拒收批次 ${batchNo}，商品退回并分配给下一顺位客户；您仍在后续批次的排队队列中。`;
      case 'WAIVED':
        return `您已放弃批次 ${batchNo}，商品已顺延给下一顺位客户；您的排队资格保留，将等待后续批次。`;
    }
  }

  private key(productId: string) {
    return `product:${productId}`;
  }

  private genOrderNo() {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `PO${stamp}${rand}`;
  }
}

export const STATUS_TEXT: Record<string, string> = {
  ASSIGNED: '待取货',
  PICKED_UP: '已取货',
  EXPIRED: '逾期退回',
  REJECTED: '已拒收',
  WAIVED: '已放弃本批',
};

export const STATE_TEXT: Record<string, string> = {
  WAITING: '排队等待中',
  ASSIGNED: '已分配，待取货',
  WAITING_AFTER_RELEASE: '已回补，继续排队',
  DONE: '已完成',
};
