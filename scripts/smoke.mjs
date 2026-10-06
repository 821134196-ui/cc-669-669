/**
 * 端到端冒烟脚本：通过 vite 代理（与浏览器同路径）走一遍核心业务流。
 * 前提：npm run dev 已启动。运行：node scripts/smoke.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const post = (path, body) => req(path, { method: 'POST', body });

const uid = Date.now().toString(36);

// 1. 创建商品
const sku = `SMOKE-${uid}`;
const { body: product } = await post('/products', { sku, name: `冒烟测试商品-${uid}` });
check('创建商品', !!product.id, product.name);

// 2. 三笔订单：B、C 同一付款时间（验证订单号稳定排序），A 最早
const t0 = '2026-01-01T10:00:00.000Z';
const orders = {};
for (const [key, customer, paidAt] of [
    ['A', '冒烟-甲', '2026-01-01T09:59:00.000Z'],
    ['B', '冒烟-乙', t0],
    ['C', '冒烟-丙', t0],
  ]) {
  const { body } = await post('/orders', {
    productId: product.id,
    customer,
    paidAt,
    orderNo: `SMK-${uid}-${key}`, // 显式订单号，保证同时间付款时排序确定（B < C）
  });
  orders[key] = body;
}
check('创建 3 笔订单（模拟支付）', ['A', 'B', 'C'].every((k) => orders[k]?.id));

// 3. 登记批次 qty=2 → 应分给 A 和 B（B、C 同时间，B 订单号更小）
const receipt1 = `RCPT-${uid}-1`;
const { body: reg1 } = await post('/batches', { productId: product.id, receivedQty: 2, receiptId: receipt1 });
check('登记批次1（实收 2）', reg1.batch?.id && !reg1.duplicated);

const detail = async (o) => (await req(`/orders/${o.orderNo}`)).body;
let dA = await detail(orders.A), dB = await detail(orders.B), dC = await detail(orders.C);
check('A 获得分配（付款最早）', dA.order.status === 'ALLOCATED');
check('B 获得分配（同时间付款，订单号更小）', dB.order.status === 'ALLOCATED');
check('C 排队第 1 位', dC.order.status === 'QUEUED' && dC.position === 1, `position=${dC.position}`);

// 4. 重复回执：不重复入库
const { body: reg1dup } = await post('/batches', { productId: product.id, receivedQty: 2, receiptId: receipt1 });
check('重复回执被幂等拦截', reg1dup.duplicated === true && reg1dup.batch.id === reg1.batch.id);
const { body: batches1 } = await req('/batches');
const b1 = batches1.find((b) => b.id === reg1.batch.id);
check('库存未重复增加', b1.receivedQty === 2 && b1.allocatedQty === 2, `received=${b1.receivedQty} allocated=${b1.allocatedQty}`);

// 5. A 放弃本批次 → C 顶上；A 回到队列且保留资格
await post(`/allocations/${dA.currentAllocation.id}/give-up`);
dA = await detail(orders.A);
dC = await detail(orders.C);
check('A 放弃后回到队列（保留资格）', dA.order.status === 'QUEUED' && dA.skippedBatches.length === 1, `skipped=${dA.skippedBatches.map((s) => s.batchNo)}`);
check('C 获得回补分配（下一顺位）', dC.order.status === 'ALLOCATED' && dC.currentAllocation.batch.batchNo === b1.batchNo);

// 6. 批次2（qty=2）到货 → A 先得 1 件；随后质检暂停 → 新订单 D 不得分配；恢复后 D 补上
const { body: reg2 } = await post('/batches', { productId: product.id, receivedQty: 2, receiptId: `RCPT-${uid}-2` });
dA = await detail(orders.A);
check('批次2 到货，A 按顺位获得', dA.order.status === 'ALLOCATED' && dA.currentAllocation.batch.batchNo === reg2.batch.batchNo);

await post(`/batches/${reg2.batch.id}/pause`);
const { body: orderD } = await post('/orders', { productId: product.id, customer: '冒烟-丁', paidAt: '2026-01-01T10:05:00.000Z', orderNo: `SMK-${uid}-D` });
let dD = await detail(orderD);
check('质检暂停期间不分配', dD.order.status === 'QUEUED' && dD.position === 1);

await post(`/batches/${reg2.batch.id}/resume`);
dD = await detail(orderD);
check('恢复后 D 获得分配', dD.order.status === 'ALLOCATED' && dD.currentAllocation.batch.batchNo === reg2.batch.batchNo);

// 7. B 确认取货 → 订单履约
await post(`/allocations/${dB.currentAllocation.id}/pickup`);
dB = await detail(orders.B);
check('B 取货完成', dB.order.status === 'FULFILLED');

// 8. C 拒收 → 订单取消，库存退回原批次
await post(`/allocations/${dC.currentAllocation.id}/reject`);
dC = await detail(orders.C);
const { body: batches2 } = await req('/batches');
const b1after = batches2.find((b) => b.id === reg1.batch.id);
check('C 拒收后订单取消', dC.order.status === 'CANCELLED' && dC.order.cancelReason === 'REJECTED');
check('拒收库存退回原批次', b1after.allocatedQty === 1, `allocated=${b1after.allocatedQty}（B 已取货 1 件）`);

// 9. 通知日志有记录
const { body: notices } = await req('/notifications');
check('通知日志已生成', notices.length >= 5, `共 ${notices.length} 条`);

console.log(failures === 0 ? '\n全部冒烟检查通过 🎉' : `\n${failures} 项检查失败`);
process.exit(failures === 0 ? 0 : 1);
