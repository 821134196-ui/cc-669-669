// 演示数据：1 个商品 + 3 笔不同付款时间的订单。运行：npm run seed
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const product = await prisma.product.upsert({
    where: { sku: 'DEMO-001' },
    update: {},
    create: { sku: 'DEMO-001', name: '限量版手办（演示商品）' },
  });

  const base = Date.now();
  const customers = ['张三', '李四', '王五'];
  for (let i = 0; i < customers.length; i++) {
    const orderNo = `DEMO${String(i + 1).padStart(6, '0')}`;
    await prisma.order.upsert({
      where: { orderNo },
      update: {},
      create: {
        orderNo,
        productId: product.id,
        customer: customers[i],
        paidAt: new Date(base + i * 60_000), // 间隔 1 分钟付款
      },
    });
  }
  console.log('演示数据就绪：商品 DEMO-001，订单 DEMO000001 ~ DEMO000003（排队中）');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
