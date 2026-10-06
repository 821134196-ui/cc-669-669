import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { OrderDetail, Product } from './types';
import { ALLOCATION_STATUS, CANCEL_REASON, ORDER_STATUS, fmtTime } from './labels';

export default function CustomerView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [orderNo, setOrderNo] = useState('');
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.products().then(setProducts).catch(() => {});
    const t = setInterval(() => api.products().then(setProducts).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  const lookup = useCallback(
    async (no?: string) => {
      const target = (no ?? orderNo).trim();
      if (!target) return;
      try {
        setDetail(await api.orderDetail(target));
        setError('');
      } catch (e) {
        setDetail(null);
        setError((e as Error).message);
      }
    },
    [orderNo],
  );

  // 查询结果每 3 秒自动刷新（顺位/分配状态会随分货变化）
  useEffect(() => {
    if (!detail) return;
    const t = setInterval(() => lookup(detail.order.orderNo), 3000);
    return () => clearInterval(t);
  }, [detail, lookup]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      setNotice(msg);
      setTimeout(() => setNotice(''), 4000);
      setError('');
      await lookup();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid">
      {error && <div className="alert error" onClick={() => setError('')}>⚠ {error}</div>}
      {notice && <div className="alert ok">✓ {notice}</div>}

      <section className="card">
        <h2>我要预订（模拟支付）</h2>
        <NewOrder
          products={products}
          onCreated={(no) => {
            setOrderNo(no);
            lookup(no);
          }}
          onError={setError}
        />
      </section>

      <section className="card">
        <h2>查询我的订单</h2>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            lookup();
          }}
        >
          <input placeholder="输入订单号" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} style={{ minWidth: 260 }} />
          <button type="submit">查询</button>
        </form>

        {detail && (
          <div className="detail">
            <StatusCard detail={detail} act={act} />
            {detail.skippedBatches.length > 0 && (
              <div className="alert warn">
                您已放弃批次：{detail.skippedBatches.map((s) => s.batchNo).join('、')}。
                <strong>放弃本批次不影响后续排队资格</strong>，新批次到货时仍按原付款时间顺位分配。
              </div>
            )}
            <h3>分配历史</h3>
            <table>
              <thead>
                <tr><th>批次</th><th>状态</th><th>取货期限</th><th>分配时间</th></tr>
              </thead>
              <tbody>
                {detail.order.allocations.map((a) => (
                  <tr key={a.id}>
                    <td>{a.batch.batchNo}</td>
                    <td><span className={`tag ${ALLOCATION_STATUS[a.status]?.cls}`}>{ALLOCATION_STATUS[a.status]?.text}</span></td>
                    <td>{fmtTime(a.deadline)}</td>
                    <td>{fmtTime(a.createdAt)}</td>
                  </tr>
                ))}
                {detail.order.allocations.length === 0 && (
                  <tr><td colSpan={4} className="empty">暂无分配记录，请等待到货</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusCard({
  detail,
  act,
}: {
  detail: OrderDetail;
  act: (fn: () => Promise<unknown>, msg: string) => Promise<void>;
}) {
  const { order, position, currentAllocation } = detail;
  const st = ORDER_STATUS[order.status];

  return (
    <div className="status-card">
      <div className="status-row">
        <span className={`tag big ${st?.cls}`}>{st?.text}</span>
        <span>订单号：<strong>{order.orderNo}</strong></span>
        <span>商品：{detail.order.product?.name}</span>
        <span>付款时间：{fmtTime(order.paidAt)}</span>
      </div>

      {order.status === 'QUEUED' && position !== null && (
        <p className="hint">您当前排在第 <strong className="hl">{position}</strong> 位，到货后将按顺位自动分配。</p>
      )}

      {order.status === 'ALLOCATED' && currentAllocation && (
        <div className="alloc-box">
          <p>
            已为您分配到批次 <strong className="hl">{currentAllocation.batch.batchNo}</strong>，
            取货期限：<strong>{fmtTime(currentAllocation.deadline)}</strong>
          </p>
          <Countdown deadline={currentAllocation.deadline} />
          <div className="btn-row">
            <button className="primary" onClick={() => act(() => api.pickup(currentAllocation.id), '取货完成！')}>确认取货</button>
            <button onClick={() => act(() => api.giveUp(currentAllocation.id), '已放弃本批次，保留后续排队资格')}>放弃本批次（保留排队资格）</button>
            <button className="danger" onClick={() => act(() => api.reject(currentAllocation.id), '已拒收，订单取消')}>拒收（取消订单）</button>
          </div>
        </div>
      )}

      {order.status === 'FULFILLED' && <p className="hint">✅ 您已取货，交易完成。</p>}
      {order.status === 'CANCELLED' && (
        <p className="hint danger-text">
          订单已取消{order.cancelReason ? `（${CANCEL_REASON[order.cancelReason] ?? order.cancelReason}）` : ''}。
        </p>
      )}
    </div>
  );
}

function Countdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remain = Math.max(0, Math.floor((new Date(deadline).getTime() - now) / 1000));
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return (
    <p className={remain === 0 ? 'danger-text' : remain < 300 ? 'warn-text' : 'hint'}>
      {remain > 0 ? `剩余取货时间：${m} 分 ${String(s).padStart(2, '0')} 秒` : '已超时，系统将把商品回补并通知下一顺位'}
    </p>
  );
}

function NewOrder({
  products,
  onCreated,
  onError,
}: {
  products: Product[];
  onCreated: (orderNo: string) => void;
  onError: (msg: string) => void;
}) {
  const [productId, setProductId] = useState('');
  const [customer, setCustomer] = useState('');
  const [paidAt, setPaidAt] = useState('');

  useEffect(() => {
    if (!productId && products.length > 0) setProductId(products[0].id);
  }, [products, productId]);

  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const order = await api.createOrder({
            productId,
            customer,
            paidAt: paidAt ? new Date(paidAt).toISOString() : undefined,
          });
          setCustomer('');
          setPaidAt('');
          onCreated(order.orderNo);
        } catch (err) {
          onError((err as Error).message);
        }
      }}
    >
      <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
        {products.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <input placeholder="客户姓名" value={customer} onChange={(e) => setCustomer(e.target.value)} required />
      <input
        type="datetime-local"
        title="付款时间（可选，用于演示同时间付款排序；留空为当前时间）"
        value={paidAt}
        onChange={(e) => setPaidAt(e.target.value)}
      />
      <button type="submit" disabled={products.length === 0}>支付并预订</button>
      {products.length === 0 && <span className="muted">请先在运营台创建商品</span>}
    </form>
  );
}
