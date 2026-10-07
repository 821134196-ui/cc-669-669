import { PrismaClient } from '@prisma/client';
import * as path from 'path';

// 统一 SQLite 文件位置（与运行时 PrismaService 的 resolveDbUrl 保持一致）
process.env.DATABASE_URL = `file:${path.join(__dirname, 'dev.db')}`;

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  // 幂等：重复执行 seed 不产生重复数据
  if ((await prisma.product.count()) > 0) {
    console.log('seed: 数据已存在，跳过');
    return;
  }

  const product = await prisma.product.create({
    data: { sku: 'SKU-LIMITED-001', name: '周年限定手办（预订款）' },
  });

  const base = Date.parse('2026-10-01T09:00:00+08:00');
  const customers: [string, string][] = [
    ['张伟', '13800000001'],
    ['李娜', '13800000002'],
    ['王强', '13800000003'],
    ['刘洋', '13800000004'],
    ['陈静', '13800000005'],
  ];
  for (let i = 0; i < customers.length; i++) {
    const [customer, phone] = customers[i];
    await prisma.order.create({
      data: {
        orderNo: `PO-SEED-${String(i + 1).padStart(3, '0')}`,
        productId: product.id,
        customer,
        phone,
        paidAt: new Date(base + i * 60_000), // 依次晚 1 分钟，顺序明确
        inQueue: true,
      },
    });
  }

  // 批次 1：正常到货 2 件 → 自动分给队列前 2 位
  const b1 = await prisma.batch.create({
    data: {
      productId: product.id,
      batchNo: 'B20261005-01',
      receivedQty: 2,
      receiptNo: 'RCP-SEED-001',
      paused: false,
      arrivedAt: new Date('2026-10-05T10:00:00+08:00'),
    },
  });
  // 批次 2：到货 3 件但质检暂停，不参与分配
  await prisma.batch.create({
    data: {
      productId: product.id,
      batchNo: 'B20261006-02',
      receivedQty: 3,
      receiptNo: 'RCP-SEED-002',
      paused: true,
      arrivedAt: new Date('2026-10-06T08:00:00+08:00'),
    },
  });

  const waiting = await prisma.order.findMany({
    where: { productId: product.id },
    orderBy: [{ paidAt: 'asc' }, { orderNo: 'asc' }],
  });
  const due = new Date(Date.now() + 48 * 3600_000);
  await prisma.allocation.createMany({
    data: waiting.slice(0, 2).map((o, i) => ({
      orderId: o.id,
      batchId: b1.id,
      queuePosition: i + 1,
      attempt: 1,
      status: 'ASSIGNED',
      pickupDueAt: due,
    })),
  });
  await prisma.batch.update({ where: { id: b1.id }, data: { allocatedQty: 2 } });
  await prisma.notification.createMany({
    data: waiting.slice(0, 2).map((o, i) => ({
      orderId: o.id,
      type: 'ASSIGNED',
      content: `您预订的商品已到货（批次 B20261005-01），排队顺位第 ${i + 1} 位，请于 ${due.toLocaleString('zh-CN', { hour12: false })} 前取货。`,
    })),
  });

  console.log('seed: 已创建 1 个商品、5 个预订订单、2 个批次（第 2 批次质检暂停）');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
