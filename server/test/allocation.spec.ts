/**
 * 关键业务场景测试（真实 SQLite 临时库）：
 *  1. 并发分货不超卖
 *  2. 同一付款时间按订单号稳定排序
 *  3. 逾期未取 → 库存回补原批次 → 通知下一顺位
 *  4. 放弃本批次 → 保留后续排队资格
 *  5. 质检暂停批次不参与分配，恢复后继续
 *  6. 重复到货回执（含并发）不重复增加库存
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../src/prisma.service';
import { NotificationService } from '../src/notification.service';
import { AllocationService } from '../src/allocation/allocation.service';

const TEST_DB_NAME = `test-${process.pid}.db`;
const SERVER_DIR = path.join(__dirname, '..');
process.env.DATABASE_URL = `file:./${TEST_DB_NAME}?connection_limit=1`;
process.env.PICKUP_WINDOW_SECONDS = '1800';

const prisma = new PrismaService();
const notify = new NotificationService(prisma);
const svc = new AllocationService(prisma, notify);

let productId: string;

async function reset() {
  await prisma.notification.deleteMany();
  await prisma.batchSkip.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.order.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.product.deleteMany();
  const p = await prisma.product.create({ data: { sku: 'SKU-1', name: '测试商品' } });
  productId = p.id;
}

async function makeOrder(orderNo: string, paidAt: Date) {
  return prisma.order.create({ data: { orderNo, productId, customer: `客户${orderNo}`, paidAt } });
}

beforeAll(async () => {
  execSync('npx prisma db push --skip-generate --schema prisma/schema.prisma', {
    cwd: SERVER_DIR,
    env: { ...process.env },
    stdio: 'ignore',
  });
  await prisma.$connect();
});

beforeEach(reset);

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const f = path.join(SERVER_DIR, 'prisma', `${TEST_DB_NAME}${suffix}`);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

describe('1. 并发分货不得超过实收数量', () => {
  it('10 个并发分配请求，5 件库存只分出 5 件', async () => {
    const { batch } = await svc.registerBatch({ productId, receivedQty: 5, receiptId: 'R-1' });
    const t = new Date('2026-01-01T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      await makeOrder(`C${String(i).padStart(3, '0')}`, new Date(t.getTime() + i * 1000));
    }
    await svc.allocateProduct(productId);

    // 并发触发 10 次分配
    await Promise.all(Array.from({ length: 10 }, () => svc.allocateBatch(batch.id)));

    const fresh = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    const allocCount = await prisma.allocation.count({ where: { batchId: batch.id } });
    const allocatedOrders = await prisma.order.count({ where: { productId, status: 'ALLOCATED' } });
    expect(fresh.allocatedQty).toBe(5);
    expect(allocCount).toBe(5);
    expect(allocatedOrders).toBe(5);
    expect(fresh.allocatedQty).toBeLessThanOrEqual(fresh.receivedQty);
  });
});

describe('2. 同一付款时间按订单号稳定排序', () => {
  it('paidAt 相同时按 orderNo 字典序分配', async () => {
    const sameTime = new Date('2026-01-01T10:00:00Z');
    // 故意乱序插入
    await makeOrder('S003', sameTime);
    await makeOrder('S001', sameTime);
    await makeOrder('S002', sameTime);
    const { batch } = await svc.registerBatch({ productId, receivedQty: 2, receiptId: 'R-2' });

    const allocs = await prisma.allocation.findMany({
      where: { batchId: batch.id },
      include: { order: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(allocs.map((a) => a.order.orderNo)).toEqual(['S001', 'S002']);
    const s003 = await prisma.order.findUniqueOrThrow({ where: { orderNo: 'S003' } });
    expect(s003.status).toBe('QUEUED');
  });
});

describe('3. 逾期未取 → 回补原批次 → 通知下一顺位', () => {
  it('A 逾期后订单取消，B 获得同批次分配并收到通知', async () => {
    const t = new Date('2026-01-01T10:00:00Z');
    await makeOrder('E001', t);
    await makeOrder('E002', new Date(t.getTime() + 1000));
    const { batch } = await svc.registerBatch({ productId, receivedQty: 1, receiptId: 'R-3' });

    const first = await prisma.allocation.findFirstOrThrow({ where: { batchId: batch.id } });
    // 人为把期限拨到过去，再触发扫描
    await prisma.allocation.update({
      where: { id: first.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    const swept = await svc.sweepExpired();
    expect(swept).toBe(1);

    const expiredAlloc = await prisma.allocation.findUniqueOrThrow({ where: { id: first.id } });
    expect(expiredAlloc.status).toBe('EXPIRED');
    const orderA = await prisma.order.findUniqueOrThrow({ where: { orderNo: 'E001' } });
    expect(orderA.status).toBe('CANCELLED');
    expect(orderA.cancelReason).toBe('EXPIRED');

    // 库存回补后分给了下一顺位 B
    const orderB = await prisma.order.findUniqueOrThrow({ where: { orderNo: 'E002' } });
    expect(orderB.status).toBe('ALLOCATED');
    const secondAlloc = await prisma.allocation.findFirstOrThrow({
      where: { batchId: batch.id, orderId: orderB.id, status: 'PENDING_PICKUP' },
    });
    expect(secondAlloc.batchId).toBe(batch.id); // 仍是原批次

    const fresh = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(fresh.allocatedQty).toBe(1); // 不超卖

    const notices = await prisma.notification.findMany({ where: { orderId: orderB.id, type: 'ALLOCATED' } });
    expect(notices.length).toBe(1);
  });
});

describe('4. 放弃本批次后保留后续排队资格', () => {
  it('A 放弃批次1 → B 顶上；批次2 到货后 A 仍最先获得分配', async () => {
    const t = new Date('2026-01-01T10:00:00Z');
    const orderA = await makeOrder('G001', t);
    const orderB = await makeOrder('G002', new Date(t.getTime() + 1000));
    const { batch: batch1 } = await svc.registerBatch({ productId, receivedQty: 1, receiptId: 'R-4a' });

    const allocA = await prisma.allocation.findFirstOrThrow({
      where: { batchId: batch1.id, orderId: orderA.id },
    });
    await svc.closeAllocation(allocA.id, 'GIVEN_UP');

    // A 回到队列，B 获得批次1
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } })).status).toBe('QUEUED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } })).status).toBe('ALLOCATED');
    const skip = await prisma.batchSkip.findUnique({
      where: { batchId_orderId: { batchId: batch1.id, orderId: orderA.id } },
    });
    expect(skip).not.toBeNull();

    // 批次2 到货：A 付款更早，应优先于仍在排队的其他人；且 A 不再被批次1 跳过逻辑影响
    const { batch: batch2 } = await svc.registerBatch({ productId, receivedQty: 1, receiptId: 'R-4b' });
    const alloc2 = await prisma.allocation.findFirstOrThrow({ where: { batchId: batch2.id } });
    expect(alloc2.orderId).toBe(orderA.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } })).status).toBe('ALLOCATED');
  });
});

describe('5. 质检暂停的批次不参与分配', () => {
  it('暂停期间不分配，恢复后立即补充分配', async () => {
    const t = new Date('2026-01-01T10:00:00Z');
    await makeOrder('Q001', t);
    const { batch } = await svc.registerBatch({ productId, receivedQty: 2, receiptId: 'R-5' });
    // 第一次登记已分掉 1 件
    expect(await prisma.allocation.count({ where: { batchId: batch.id } })).toBe(1);

    await svc.setBatchStatus(batch.id, 'QC_PAUSED');
    await makeOrder('Q002', new Date(t.getTime() + 1000)); // 触发 allocateProduct，但批次已暂停
    expect(await prisma.allocation.count({ where: { batchId: batch.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderNo: 'Q002' } })).status).toBe('QUEUED');

    await svc.setBatchStatus(batch.id, 'ACTIVE');
    expect(await prisma.allocation.count({ where: { batchId: batch.id } })).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { orderNo: 'Q002' } })).status).toBe('ALLOCATED');
  });
});

describe('6. 重复到货回执不重复增加库存', () => {
  it('顺序重复 + 并发重复都只算一次', async () => {
    const first = await svc.registerBatch({ productId, receivedQty: 3, receiptId: 'R-6' });
    const second = await svc.registerBatch({ productId, receivedQty: 3, receiptId: 'R-6' });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(second.batch.id).toBe(first.batch.id);

    // 并发重复回执
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.registerBatch({ productId, receivedQty: 4, receiptId: 'R-6' }),
      ),
    );
    expect(results.every((r) => r.duplicated)).toBe(true);

    const batches = await prisma.batch.findMany({ where: { receiptId: 'R-6' } });
    expect(batches.length).toBe(1);
    expect(batches[0].receivedQty).toBe(3); // 数量未被篡改
  });
});
