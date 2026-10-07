/* eslint-disable no-console */
/**
 * 分配引擎场景测试（临时 SQLite 文件库，跑完删除）：
 * 1. 稳定排序：paidAt 相同按订单号
 * 2. 并发到货不超卖（产品级锁 + 条件扣减）
 * 3. 逾期 → 退回原批次、下一顺位补位，且本人不会立刻分回刚逾期的批次
 * 4. 放弃本批：保留排队资格、货顺延下一顺位
 * 5. 拒收同样回补
 * 6. 取货交付：离开队列，实收/占用各减 1
 * 7. 质检暂停批次不参与分配，恢复后补排
 * 8. 重复到货回执不增加库存
 */
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

const dbFile = path.join(__dirname, '..', 'prisma', 'test-engine.db');
for (const f of [dbFile, `${dbFile}-journal`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.PICKUP_DEADLINE_HOURS = '1';

import { execSync } from 'child_process';
execSync('npx prisma db push --skip-generate --accept-data-loss', {
  cwd: path.join(__dirname, '..'),
  stdio: 'pipe',
  env: process.env,
});

import { PrismaService } from '../src/common/prisma.service';
import { LockService } from '../src/common/lock.service';
import { NotificationService } from '../src/common/notification.service';
import { PaymentService } from '../src/common/payment.service';
import { AllocationEngine } from '../src/allocation/allocation.engine';

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  const locks = new LockService();
  const notifications = new NotificationService(prisma);
  const payments = new PaymentService();
  const engine = new AllocationEngine(prisma, locks, notifications, payments);

  const product = await prisma.product.create({ data: { sku: 'T-1', name: '测试商品' } });

  // 6 个订单：前 4 个同一 paidAt（验证订单号稳定排序），后 2 个依次更晚
  const t0 = new Date('2026-10-01T00:00:00.000Z');
  const mk = async (orderNo: string, paidAt: Date) =>
    prisma.order.create({
      data: { orderNo, productId: product.id, customer: orderNo, phone: '13800000000', paidAt, inQueue: true },
    });
  await mk('PO-B-002', t0);
  await mk('PO-B-001', t0);
  await mk('PO-B-003', t0);
  await mk('PO-B-004', t0);
  await mk('PO-A-005', new Date(t0.getTime() + 60_000));
  await mk('PO-A-006', new Date(t0.getTime() + 120_000));

  console.log('\n[1] 稳定排序：paidAt 相同按订单号')
  await engine.registerReceipt(product.id, 'B-1', 2, 'R-1');
  const q1 = await engine.getQueue(product.id);
  const got1 = q1.filter((q) => q.active).map((q) => q.orderNo).sort();
  check('前 2 位是 PO-B-001、PO-B-002', JSON.stringify(got1) === JSON.stringify(['PO-B-001', 'PO-B-002']));
  const v2 = await engine.getOrderView('PO-B-002');
  check('分货顺位记录为第 2 位', v2.active!.queuePosition === 2);

  console.log('\n[2] 质检暂停批次不参与分配')
  await prisma.batch.create({
    data: { productId: product.id, batchNo: 'B-PAUSE', receivedQty: 2, receiptNo: 'R-PAUSE', paused: true },
  });
  check('暂停批次到货后待取货分配仍是 2 笔',
    (await prisma.allocation.count({ where: { status: 'ASSIGNED' } })) === 2);

  console.log('\n[3] 并发到货：两个批次各 2 件并发登记，恰好填满剩余 4 个等待订单')
  await Promise.all([
    engine.registerReceipt(product.id, 'B-2', 2, 'R-2'),
    engine.registerReceipt(product.id, 'B-3', 2, 'R-3'),
  ]);
  const activeAllocs = await prisma.allocation.findMany({ where: { status: 'ASSIGNED' } });
  const nonPausedBatches = await prisma.batch.findMany({
    where: { productId: product.id, paused: false },
  });
  check('6 个排队订单各持有恰好 1 笔待取货分配', activeAllocs.length === 6);
  check('非暂停批次总占用 = 6，且没有任何批次超卖',
    nonPausedBatches.reduce((s, b) => s + b.allocatedQty, 0) === 6 &&
      nonPausedBatches.every((b) => b.allocatedQty <= b.receivedQty));
  const perOrder = await prisma.allocation.groupBy({ by: ['orderId'], where: { status: 'ASSIGNED' }, _count: true });
  check('每单待取货分配数恰好 1', perOrder.length === 6 && perOrder.every((g) => g._count === 1));

  console.log('\n[4] 逾期退回原批次 → 下一顺位新订单补位；本人不分回同批')
  const order7 = await engine.placeOrder(product.id, '客户7', '13800000007');
  check('队尾新订单暂无货可分、顺位第 1', order7.active === null && order7.queuePosition === 1);
  const po1 = await engine.getOrderView('PO-B-001');
  const releasedBatchNo = po1.active!.batchNo; // B-1
  const expiredView = await engine.forceExpire(po1.active!.id);
  check('逾期后 PO-B-001 状态为“已回补，继续排队”', expiredView.state === 'WAITING_AFTER_RELEASE');
  const po7 = await engine.getOrderView(order7.orderNo);
  check('下一顺位新订单分到逾期退回的那一件（同批次）',
    po7.active !== null && po7.active.batchNo === releasedBatchNo);
  const po1Again = await engine.getOrderView('PO-B-001');
  check('PO-B-001 仍在排队且没有被分回刚逾期的批次',
    po1Again.active === null && po1Again.queuePosition === 1);

  console.log('\n[5] 放弃本批：货顺延下一顺位，本人保留资格且不再分回同批')
  const order8 = await engine.placeOrder(product.id, '客户8', '13800000008');
  // 当前等待：PO-B-001（第1，排除 B-1）、order8（第2）
  await engine.registerReceipt(product.id, 'B-5', 1, 'R-5');
  const head = await engine.getOrderView('PO-B-001');
  check('队首 PO-B-001 分到新批次 B-5（不是它放弃过的 B-1）', head.active?.batchNo === 'B-5');
  check('order8 仍等待（队首离开后升为第 1 位）', (await engine.getOrderView(order8.orderNo)).queuePosition === 1);
  const waived = await engine.waive(head.active!.id);
  check('放弃后状态为回补继续排队、无待取货', waived.state === 'WAITING_AFTER_RELEASE' && waived.active === null);
  const order8View = await engine.getOrderView(order8.orderNo);
  check('B-5 顺延给下一顺位 order8', order8View.active?.batchNo === 'B-5');
  const headAfter = await engine.getOrderView('PO-B-001');
  check('PO-B-001 没有被分回 B-5，继续排第 1 位',
    headAfter.active === null && headAfter.queuePosition === 1);

  console.log('\n[6] 拒收同样回补下一顺位')
  const order9 = await engine.placeOrder(product.id, '客户9', '13800000009');
  await engine.reject(order8View.active!.id);
  const order9View = await engine.getOrderView(order9.orderNo);
  check('拒收后 B-5 顺延给 order9', order9View.active?.batchNo === 'B-5');
  const order8After = await engine.getOrderView(order8.orderNo);
  check('order8 拒收后仍排队', order8After.state === 'WAITING_AFTER_RELEASE');

  console.log('\n[7] 取货交付：离开队列，批次实收/占用各减 1')
  const b5 = await prisma.batch.findFirstOrThrow({ where: { batchNo: 'B-5' } });
  await engine.pickup(order9View.active!.id);
  const b5After = await prisma.batch.findFirstOrThrow({ where: { batchNo: 'B-5' } });
  check('B-5 receivedQty 与 allocatedQty 各减 1',
    b5After.receivedQty === b5.receivedQty - 1 && b5After.allocatedQty === b5.allocatedQty - 1);
  const doneView = await engine.getOrderView(order9.orderNo);
  check('取货订单状态 DONE 且离开排队', doneView.state === 'DONE' && doneView.inQueue === false);

  console.log('\n[8] 暂停批次恢复后立刻补排')
  const waitingBeforeResume = (await engine.getQueue(product.id)).filter((q) => q.queuePosition !== null).length;
  check(`恢复前有 ${waitingBeforeResume} 单在等`, waitingBeforeResume >= 1);
  const pausedBatch = (await prisma.batch.findFirstOrThrow({ where: { batchNo: 'B-PAUSE' } }));
  await engine.setPaused(pausedBatch.id, false);
  const stillWaiting = (await engine.getQueue(product.id)).filter((q) => q.queuePosition !== null).length;
  check(`恢复后等待人数 ${waitingBeforeResume} → ${stillWaiting}`, stillWaiting === 0);
  const resumeRow = await prisma.batch.findUniqueOrThrow({ where: { id: pausedBatch.id } });
  check(`恢复批次占用 = 等待人数 ${waitingBeforeResume}，恰好分完其 2 件库存`,
    resumeRow.allocatedQty === waitingBeforeResume && resumeRow.allocatedQty === 2
    && resumeRow.receivedQty - resumeRow.allocatedQty === 0);

  console.log('\n[9] 重复到货回执幂等，不增加库存')
  const dup = await engine.registerReceipt(product.id, 'B-1-DUP', 999, 'R-1');
  check('重复回执返回 duplicated=true', dup.duplicated === true);
  const r1 = await prisma.batch.findFirstOrThrow({ where: { receiptNo: 'R-1' } });
  check('原批次实收仍为 2', r1.receivedQty === 2);
  check('同一回执只有一条批次记录',
    (await prisma.batch.count({ where: { receiptNo: 'R-1' } })) === 1);

  console.log('\n[10] 高并发压力：10 个批次各 1 件在一个 Promise.all 中登记，5 人排队')
  for (let i = 0; i < 5; i++) {
    await engine.placeOrder(product.id, `并发客户${i}`, `1390000${1000 + i}`);
  }
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      engine.registerReceipt(product.id, `B-C${i}`, 1, `R-C${i}`),
    ),
  );
  const raceBatches = await prisma.batch.findMany({ where: { receiptNo: { startsWith: 'R-C' } } });
  const raceAllocated = raceBatches.reduce((s, b) => s + b.allocatedQty, 0);
  check('10 件库存只分出 5 件（5 个等待订单），不超卖', raceAllocated === 5);
  check('每个并发批次占用 0 或 1，且不超实收', raceBatches.every((b) => b.allocatedQty <= 1));
  const raceAllocs = await prisma.allocation.findMany({
    where: { batchId: { in: raceBatches.map((b) => b.id) }, status: 'ASSIGNED' },
    include: { order: true },
  });
  check('恰好 5 个不同订单分到货', new Set(raceAllocs.map((a) => a.orderId)).size === 5);
  check('分到的正是最后入队的 5 个“并发客户”',
    raceAllocs.every((a) => a.order.customer.startsWith('并发客户')));

  console.log(`\n全部通过：${passed} 项断言`);
  await prisma.$disconnect();
}

main()
  .then(() => {
    for (const f of [dbFile, `${dbFile}-journal`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n测试失败：', e);
    process.exit(1);
  });
