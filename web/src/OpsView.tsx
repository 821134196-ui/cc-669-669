import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Allocation, Batch, NotificationItem, Order, Product } from './types';
import { ALLOCATION_STATUS, BATCH_STATUS, CANCEL_REASON, NOTIFY_TYPE, ORDER_STATUS, fmtTime } from './labels';

export default function OpsView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [p, b, o, a, n] = await Promise.all([
        api.products(),
        api.batches(),
        api.orders(),
        api.allocations(),
        api.notifications(),
      ]);
      setProducts(p);
      setBatches(b);
      setOrders(o);
      setAllocations(a);
      setNotifications(n);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      setError('');
      if (okMsg) setNotice(okMsg);
      setTimeout(() => setNotice(''), 4000);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid">
      {error && <div className="alert error" onClick={() => setError('')}>⚠ {error}</div>}
      {notice && <div className="alert ok">✓ {notice}</div>}

      <section className="card">
        <h2>商品</h2>
        <CreateProduct run={run} />
        <table>
          <thead>
            <tr><th>SKU</th><th>名称</th></tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}><td>{p.sku}</td><td>{p.name}</td></tr>
            ))}
            {products.length === 0 && <tr><td colSpan={2} className="empty">暂无商品，请先创建</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>到货登记（实收批次）</h2>
        <RegisterBatch products={products} run={run} />
        <table>
          <thead>
            <tr>
              <th>批次号</th><th>商品</th><th>实收</th><th>已分配</th><th>可分配</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.batchNo}</td>
                <td>{b.product?.name}</td>
                <td>{b.receivedQty}</td>
                <td>{b.allocatedQty}</td>
                <td>{b.receivedQty - b.allocatedQty}</td>
                <td><span className={`tag ${BATCH_STATUS[b.status]?.cls}`}>{BATCH_STATUS[b.status]?.text}</span></td>
                <td>
                  {b.status === 'ACTIVE' ? (
                    <button className="small danger" onClick={() => run(() => api.pauseBatch(b.id), `批次 ${b.batchNo} 已质检暂停`)}>质检暂停</button>
                  ) : (
                    <button className="small" onClick={() => run(() => api.resumeBatch(b.id), `批次 ${b.batchNo} 已恢复，继续分配`)}>恢复分配</button>
                  )}
                </td>
              </tr>
            ))}
            {batches.length === 0 && <tr><td colSpan={7} className="empty">暂无批次</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>预订队列（按付款时间排序，不可人工插队）</h2>
        <table>
          <thead>
            <tr><th>顺位</th><th>订单号</th><th>客户</th><th>商品</th><th>付款时间</th><th>状态</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.position ? `第 ${o.position} 位` : '-'}</td>
                <td>{o.orderNo}</td>
                <td>{o.customer}</td>
                <td>{o.product?.name}</td>
                <td>{fmtTime(o.paidAt)}</td>
                <td>
                  <span className={`tag ${ORDER_STATUS[o.status]?.cls}`}>{ORDER_STATUS[o.status]?.text}</span>
                  {o.status === 'CANCELLED' && o.cancelReason && (
                    <span className="muted">（{CANCEL_REASON[o.cancelReason] ?? o.cancelReason}）</span>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={6} className="empty">暂无订单</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>
          分配记录
          <button className="small" style={{ marginLeft: 12 }} onClick={() => run(async () => {
            const r = await api.sweepExpired();
            if (r.swept > 0) setNotice(`已扫描并回补 ${r.swept} 笔逾期分配`);
          })}>手动扫描逾期</button>
        </h2>
        <table>
          <thead>
            <tr><th>订单号</th><th>客户</th><th>批次</th><th>状态</th><th>取货期限</th><th>创建时间</th></tr>
          </thead>
          <tbody>
            {allocations.map((a) => (
              <tr key={a.id}>
                <td>{a.order?.orderNo}</td>
                <td>{a.order?.customer}</td>
                <td>{a.batch?.batchNo}</td>
                <td><span className={`tag ${ALLOCATION_STATUS[a.status]?.cls}`}>{ALLOCATION_STATUS[a.status]?.text}</span></td>
                <td>{fmtTime(a.deadline)}</td>
                <td>{fmtTime(a.createdAt)}</td>
              </tr>
            ))}
            {allocations.length === 0 && <tr><td colSpan={6} className="empty">暂无分配</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>通知日志（本地模拟）</h2>
        <table>
          <thead>
            <tr><th>时间</th><th>类型</th><th>内容</th></tr>
          </thead>
          <tbody>
            {notifications.map((n) => {
              let payload: Record<string, unknown> = {};
              try { payload = JSON.parse(n.payload); } catch { /* ignore */ }
              return (
                <tr key={n.id}>
                  <td>{fmtTime(n.createdAt)}</td>
                  <td><span className="tag tag-blue">{NOTIFY_TYPE[n.type] ?? n.type}</span></td>
                  <td className="muted">
                    {String(payload.orderNo ?? '')} {String(payload.message ?? '')}
                  </td>
                </tr>
              );
            })}
            {notifications.length === 0 && <tr><td colSpan={3} className="empty">暂无通知</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CreateProduct({ run }: { run: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await api.createProduct({ sku, name });
          setSku('');
          setName('');
        }, '商品已创建');
      }}
    >
      <input placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} required />
      <input placeholder="商品名称" value={name} onChange={(e) => setName(e.target.value)} required />
      <button type="submit">创建商品</button>
    </form>
  );
}

function RegisterBatch({ products, run }: { products: Product[]; run: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [receiptId, setReceiptId] = useState('');
  const [batchNo, setBatchNo] = useState('');

  useEffect(() => {
    if (!productId && products.length > 0) setProductId(products[0].id);
  }, [products, productId]);

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await api.registerBatch({
            productId,
            receivedQty: Number(qty),
            receiptId,
            batchNo: batchNo || undefined,
          });
          if (r.duplicated) {
            alert(`回执 ${receiptId} 已登记过（批次 ${r.batch.batchNo}），本次不重复入库`);
          }
          setReceiptId('');
          setBatchNo('');
        }, '批次已登记并触发分配');
      }}
    >
      <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
        {products.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <input type="number" min="1" placeholder="实收数量" value={qty} onChange={(e) => setQty(e.target.value)} required style={{ width: 90 }} />
      <input placeholder="到货回执号（幂等键）" value={receiptId} onChange={(e) => setReceiptId(e.target.value)} required />
      <input placeholder="批次号（可空，自动生成）" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
      <button type="submit" disabled={products.length === 0}>登记到货</button>
    </form>
  );
}
