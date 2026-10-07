/* 端到端 HTTP 冒烟：恢复暂停批 → 逾期顺延 → 放弃 → 重复回执 → 并发到货 */
const B = 'http://localhost:3001/api';
const j = async (url, init) => {
  const r = await fetch(B + url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
};
const log = (...a) => console.log(...a);

(async () => {
  const [product] = await j('/products');
  const pid = product.id;

  log('=== 3. 恢复暂停批次 B20261006-02（3 件）→ 应补排给 PO-SEED-003/004/005 ===');
  const paused = (await j(`/batches?productId=${pid}`)).find((b) => b.paused);
  await j(`/batches/${paused.id}`, { method: 'PATCH', body: JSON.stringify({ paused: false }) });
  for (const no of ['PO-SEED-003', 'PO-SEED-004', 'PO-SEED-005']) {
    const o = await j(`/orders/${no}`);
    log(' ', no, o.state, o.active ? `分到 ${o.active.batchNo}（分货顺位 ${o.active.queuePosition}）` : '仍等待');
  }

  log('=== 4. PO-SEED-001 模拟逾期 → 货退回 B20261005-01；下一顺位（新订单）补位 ===');
  const o1 = await j('/orders/PO-SEED-001');
  await j(`/allocations/${o1.active.id}/expire`, { method: 'POST' });
  const after = await j('/orders/PO-SEED-001');
  log('  PO-SEED-001:', after.state, '| 持有批次:', after.active ?? '无（继续排队）');
  const fresh = await j('/orders', {
    method: 'POST',
    body: JSON.stringify({ productId: pid, customer: '冒烟客户', phone: '13700000001' }),
  });
  log('  新订单', fresh.orderNo, fresh.state, '分到', fresh.active?.batchNo, '顺位', fresh.active?.queuePosition);

  log('=== 5. 新订单放弃本批 → 顺延给下一顺位（PO-SEED-001），但不会分回 B01 ===');
  await j(`/allocations/${fresh.active.id}/waive`, { method: 'POST' });
  const fresh2 = await j('/orders/' + fresh.orderNo);
  log('  放弃后:', fresh2.state, '持有:', fresh2.active ?? '无');
  const backfill = await j('/orders/PO-SEED-001');
  log('  PO-SEED-001 现在分到:', backfill.active?.batchNo ?? '无', '（B20261005-01 对它应被排除）');

  log('=== 6. 重复到货回执幂等 ===');
  const dup = await j('/batches', {
    method: 'POST',
    body: JSON.stringify({ productId: pid, batchNo: 'B-DUP', receivedQty: 999, receiptNo: 'RCP-SEED-001' }),
  });
  log('  重复回执结果 duplicated =', dup.duplicated);
  const batches = await j(`/batches?productId=${pid}`);
  const b01 = batches.find((b) => b.batchNo === 'B20261005-01');
  log('  B20261005-01 实收仍为', b01.receivedQty, '批次总数', batches.length, '（无 B-DUP）');

  log('=== 7. 并发登记 6 个批次各 1 件（同一产品，验证不超卖/不重复分给同一单）===');
  const waiters = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      j('/orders', {
        method: 'POST',
        body: JSON.stringify({ productId: pid, customer: `并发${i}`, phone: `1360000${1000 + i}` }),
      }),
    ),
  );
  log('  新入队 3 单，当前等待顺位:', waiters.map((w) => w.queuePosition).join(','));
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      j('/batches', {
        method: 'POST',
        body: JSON.stringify({ productId: pid, batchNo: `B-RACE-${i}`, receivedQty: 1, receiptNo: `R-RACE-${i}` }),
      }),
    ),
  );
  log('  6 个并发回执 duplicated:', results.map((r) => r.duplicated).join(','));
  const afterBatches = await j(`/batches?productId=${pid}`);
  const race = afterBatches.filter((b) => b.batchNo.startsWith('B-RACE'));
  log('  竞争批总占用 =', race.reduce((s, b) => s + b.allocatedQty,  0), '/ 6，无超卖:',
    race.every((b) => b.allocatedQty <= 1));
  const q = await j(`/products/${pid}/queue`);
  log('  队列最终状态:');
  q.forEach((row) =>
    log('   ', row.queuePosition ? `第${row.queuePosition}位` : '  -  ', row.orderNo, row.customer,
      row.active ? `→ ${row.active.batchNo}` : row.inQueue ? '等待' : '已离队'),
  );

  log('=== 8. 最近通知 ===');
  const notes = await j('/notifications?limit=6');
  notes.slice(0, 6).forEach((n) => log('   ', n.type, n.order.orderNo, n.content.slice(0, 42) + '…'));
})().catch((e) => {
  console.error('冒烟失败:', e.message);
  process.exit(1);
});
