import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  BatchView,
  fmt,
  NoticeRow,
  OrderView,
  Product,
  QueueRow,
} from './api';

type Tab = 'customer' | 'ops';

export default function App() {
  const [tab, setTab] = useState<Tab>('customer');
  return (
    <div className="app">
      <header className="app-header">
        <h1>预订到货批次分配系统</h1>
        <p>按付款成功时间顺位分货 · 逾期/拒收/放弃自动回补下一顺位 · 质检批次暂停分配</p>
      </header>
      <div className="tabs">
        <button className={tab === 'customer' ? 'active' : ''} onClick={() => setTab('customer')}>
          客户查询
        </button>
        <button className={tab === 'ops' ? 'active' : ''} onClick={() => setTab('ops')}>
          运营台
        </button>
      </div>
      {tab === 'customer' ? <CustomerView /> : <OpsView />}
    </div>
  );
}

/* ============================== 客户查询 ============================== */

function CustomerView() {
  const [orderNo, setOrderNo] = useState('');
  const [order, setOrder] = useState<OrderView | null>(null);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useCallback(async (no: string) => {
    if (!no.trim()) return;
    setBusy(true);
    setError('');
    try {
      const [o, n] = await Promise.all([
        api.order(no.trim()),
        api.notifications(no.trim()),
      ]);
      setOrder(o);
      setNotices(n);
    } catch (e) {
      setOrder(null);
      setNotices([]);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  // 每 5 秒自动刷新（看到期倒计时 / 顺位变化）
  useEffect(() => {
    if (!order) return;
    const t = setInterval(() => query(order.orderNo), 5000);
    return () => clearInterval(t);
  }, [order?.orderNo]); // eslint-disable-line react-hooks/exhaustive-deps

  const waive = async () => {
    if (!order?.active) return;
    if (!confirm('确定放弃本批次商品？放弃后本批顺延给下一顺位，您仍保留后续批次的排队资格。')) return;
    setError('');
    try {
      const o = await api.act(order.active.id, 'waive');
      setOrder(o);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="card">
        <h2>查询我的排队与到货信息</h2>
        <div className="row">
          <input
            style={{ flex: '1 1 260px' }}
            placeholder="输入订单号，如 PO-SEED-001"
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && query(orderNo)}
          />
          <button className="btn" disabled={busy} onClick={() => query(orderNo)}>
            查询
          </button>
        </div>
        {error && <div className="error">查询失败：{error}</div>}
      </div>

      {order && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>
                订单 <span className="mono">{order.orderNo}</span>
              </h2>
              <StateBadge state={order.state} />
            </div>
            <p className="muted" style={{ margin: '6px 0 14px' }}>
              {order.customer} · {order.phone} · {order.product.name}（{order.product.sku}）·
              付款时间 {fmt(order.paidAt)}
            </p>

            {order.active ? (
              <div>
                <div className="position-hero">
                  <div className="position-num">第 {order.active.queuePosition} 顺位</div>
                  <div className="position-meta">
                    本批为第 {order.active.attempt} 次分到货
                    <br />
                    批次号 <b className="mono">{order.active.batchNo}</b>
                  </div>
                </div>
                <h3>取货期限</h3>
                <dl className="kv">
                  <dt>截止时间</dt>
                  <dd>
                    <b>{fmt(order.active.pickupDueAt)}</b>{' '}
                    <span className="muted">（剩余约 {order.active.hoursLeft} 小时）</span>
                  </dd>
                  <dt>逾期规则</dt>
                  <dd className="muted">逾期未取或拒收，商品退回本批次并自动通知下一顺位客户</dd>
                </dl>
                <div className="row section-gap">
                  <button className="btn warn" onClick={waive}>
                    放弃本批次（保留排队资格）
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="position-hero">
                  <div className="position-num">
                    {order.queuePosition ? `第 ${order.queuePosition} 位` : '—'}
                  </div>
                  <div className="position-meta">
                    {order.state === 'DONE'
                      ? '订单已完成，感谢购买'
                      : `等待后续批次到货 · 队列共 ${order.waitingTotal} 人，前面还有 ${order.aheadCount} 人`}
                  </div>
                </div>
                {order.state === 'WAITING_AFTER_RELEASE' && (
                  <div className="ok section-gap">
                    您放弃/错过的商品已顺延给下一顺位客户；您的排队资格保留，将按原付款顺位等待后续批次，
                    且不会再被分回刚放弃的同一批次。
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h2>分配记录</h2>
            <table>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>分货顺位</th>
                  <th>第几次</th>
                  <th>取货期限</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {order.history.map((h) => (
                  <tr key={h.id}>
                    <td className="mono">{h.batchNo}</td>
                    <td>第 {h.queuePosition} 位</td>
                    <td>{h.attempt}</td>
                    <td>{fmt(h.pickupDueAt)}</td>
                    <td>
                      <HistoryBadge status={h.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>通知短信</h2>
            {notices.length === 0 && <p className="muted">暂无通知</p>}
            {notices.map((n) => (
              <div key={n.id} className={`notice ${n.type}`}>
                {n.content}
                <div className="meta">{fmt(n.createdAt)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: OrderView['state'] }) {
  const map: Record<OrderView['state'], [string, string]> = {
    WAITING: ['gray', '排队等待中'],
    ASSIGNED: ['blue', '已分配，待取货'],
    WAITING_AFTER_RELEASE: ['amber', '已回补，继续排队'],
    DONE: ['green', '已完成'],
  };
  const [cls, text] = map[state];
  return <span className={`badge ${cls}`}>{text}</span>;
}

function HistoryBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    ASSIGNED: ['blue', '待取货'],
    PICKED_UP: ['green', '已取货'],
    EXPIRED: ['red', '逾期退回'],
    REJECTED: ['red', '已拒收'],
    WAIVED: ['amber', '已放弃本批'],
  };
  const [cls, text] = map[status] ?? ['gray', status];
  return <span className={`badge ${cls}`}>{text}</span>;
}

/* ============================== 运营台 ============================== */

function OpsView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // 新订单表单
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  // 到货登记表单
  const [batchNo, setBatchNo] = useState('');
  const [qty, setQty] = useState('1');
  const [receiptNo, setReceiptNo] = useState('');

  const refresh = useCallback(async (pid: string) => {
    const [q, b, n] = await Promise.all([
      api.queue(pid),
      api.batches(pid),
      api.notifications(),
    ]);
    setQueue(q);
    setBatches(b);
    setNotices(n);
  }, []);

  useEffect(() => {
    api.products().then((ps) => {
      setProducts(ps);
      if (ps[0]) {
        setProductId(ps[0].id);
        refresh(ps[0].id);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!productId) return;
    refresh(productId);
    const t = setInterval(() => refresh(productId), 5000);
    return () => clearInterval(t);
  }, [productId, refresh]);

  const switchProduct = (id: string) => {
    setProductId(id);
    setMsg('');
    setErr('');
  };

  const flash = (ok: string) => {
    setMsg(ok);
    setErr('');
    setTimeout(() => setMsg(''), 4000);
  };
  const fail = (e: unknown) => {
    setErr((e as Error).message);
  };

  const placeOrder = async () => {
    if (!customer.trim() || !phone.trim()) return;
    try {
      const o = await api.placeOrder(productId, customer.trim(), phone.trim());
      flash(`支付成功，订单 ${o.orderNo} 已按付款时间入队`);
      setCustomer('');
      setPhone('');
      await refresh(productId);
    } catch (e) {
      fail(e);
    }
  };

  const registerBatch = async () => {
    const n = Number(qty);
    if (!batchNo.trim() || !receiptNo.trim() || !Number.isInteger(n) || n <= 0) {
      setErr('请填写批次号、正整数实收数量与到货回执单号');
      return;
    }
    try {
      const r = await api.registerBatch(productId, batchNo.trim(), n, receiptNo.trim());
      if (r.duplicated) flash('该到货回执已登记过（幂等），未重复增加库存');
      else flash(`批次 ${batchNo} 到货 ${n} 件，已按顺位完成分货`);
      setBatchNo('');
      setQty('1');
      setReceiptNo('');
      await refresh(productId);
    } catch (e) {
      fail(e);
    }
  };

  const act = async (id: string, action: 'pickup' | 'reject' | 'expire') => {
    try {
      await api.act(id, action);
      await refresh(productId);
    } catch (e) {
      fail(e);
    }
  };

  const togglePause = async (b: BatchView) => {
    try {
      await api.setPaused(b.id, !b.paused);
      flash(b.paused ? `批次 ${b.batchNo} 已恢复质检通过，重新参与分配` : `批次 ${b.batchNo} 已暂停，暂停期间不参与分配`);
      await refresh(productId);
    } catch (e) {
      fail(e);
    }
  };

  const totals = batches.reduce(
    (acc, b) => {
      acc.received += b.receivedQty;
      acc.allocated += b.allocatedQty;
      acc.remaining += b.remainingQty;
      return acc;
    },
    { received: 0, allocated: 0, remaining: 0 },
  );

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>运营台</h2>
          <select value={productId} onChange={(e) => switchProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.sku}）
              </option>
            ))}
          </select>
        </div>
        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}
        <div className="muted section-gap qty-pill">
          累计实收 {totals.received} 件 · 已分配（含待取货）{totals.allocated} 件 · 当前可分余量{' '}
          {totals.remaining} 件（暂停批次的库存不计入可分）
        </div>
      </div>

      <div className="card">
        <h2>登记实收到货批次</h2>
        <div className="row">
          <input placeholder="批次号，如 B20261007-03" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
          <input
            style={{ width: 130 }}
            placeholder="实收数量"
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <input
            style={{ flex: '1 1 200px' }}
            placeholder="到货回执单号（重复提交不增加库存）"
            value={receiptNo}
            onChange={(e) => setReceiptNo(e.target.value)}
          />
          <button className="btn" onClick={registerBatch}>
            登记到货并分货
          </button>
        </div>
      </div>

      <div className="card">
        <h2>模拟支付下单（预订入队）</h2>
        <div className="row">
          <input placeholder="客户姓名" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn ghost" onClick={placeOrder}>
            支付成功并入队
          </button>
        </div>
      </div>

      <div className="card">
        <h2>到货批次</h2>
        <table>
          <thead>
            <tr>
              <th>批次号</th>
              <th>回执单号</th>
              <th>实收</th>
              <th>已分配</th>
              <th>可分余量</th>
              <th>质检状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} style={b.paused ? { background: 'var(--amber-weak)' } : undefined}>
                <td className="mono">{b.batchNo}</td>
                <td className="mono muted">{b.receiptNo}</td>
                <td className="qty-pill">{b.receivedQty}</td>
                <td className="qty-pill">{b.allocatedQty}</td>
                <td className="qty-pill">{b.paused ? 0 : b.remainingQty}</td>
                <td>
                  {b.paused ? <span className="badge amber">质检暂停</span> : <span className="badge green">正常</span>}
                </td>
                <td>
                  <button className="btn tiny subtle" onClick={() => togglePause(b)}>
                    {b.paused ? '恢复并补排' : '暂停'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>预订队列（按付款成功时间、订单号稳定排序）</h2>
        <table>
          <thead>
            <tr>
              <th>等待顺位</th>
              <th>订单号</th>
              <th>客户</th>
              <th>付款成功时间</th>
              <th>当前批次 / 取货期限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((row) => (
              <tr key={row.id}>
                <td>{row.queuePosition ? `第 ${row.queuePosition} 位` : <span className="muted">—</span>}</td>
                <td className="mono">{row.orderNo}</td>
                <td>
                  {row.customer} <span className="muted">{row.phone}</span>
                </td>
                <td>{fmt(row.paidAt)}</td>
                <td>
                  {row.active ? (
                    <span>
                      <span className="mono">{row.active.batchNo}</span>
                      {row.active.overdue ? (
                        <span className="badge red" style={{ marginLeft: 8 }}>
                          已逾期
                        </span>
                      ) : (
                        <span className="muted" style={{ marginLeft: 8 }}>
                          期限 {fmt(row.active.pickupDueAt)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="muted">{row.inQueue ? '等待到货' : '已离开队列'}</span>
                  )}
                </td>
                <td>
                  {row.active ? (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn tiny" onClick={() => act(row.active!.id, 'pickup')}>
                        确认取货
                      </button>
                      <button className="btn tiny danger" onClick={() => act(row.active!.id, 'reject')}>
                        拒收
                      </button>
                      <button className="btn tiny warn" onClick={() => act(row.active!.id, 'expire')}>
                        模拟逾期
                      </button>
                    </div>
                  ) : (
                    <span className="muted">{row.lastStatus ? labelOf(row.lastStatus) : ''}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>实时通知（每 5 秒刷新）</h2>
        {notices.slice(0, 12).map((n) => (
          <div key={n.id} className={`notice ${n.type}`}>
            <b className="mono">{n.order.orderNo}</b> · {n.content}
            <div className="meta">
              {n.order.customer} · {fmt(n.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function labelOf(status: string) {
  return (
    { ASSIGNED: '待取货', PICKED_UP: '已取货', EXPIRED: '逾期，继续排队', REJECTED: '拒收，继续排队', WAIVED: '放弃，继续排队' }[
      status
    ] ?? status
  );
}
