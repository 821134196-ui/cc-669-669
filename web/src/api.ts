export interface Product {
  id: string;
  sku: string;
  name: string;
}

export type OrderState =
  | 'WAITING'
  | 'ASSIGNED'
  | 'WAITING_AFTER_RELEASE'
  | 'DONE';

export interface AllocationHistoryItem {
  id: string;
  batchNo: string;
  status: 'ASSIGNED' | 'PICKED_UP' | 'EXPIRED' | 'REJECTED' | 'WAIVED';
  statusText: string;
  attempt: number;
  queuePosition: number;
  assignedAt: string;
  pickupDueAt: string;
  settledAt: string | null;
  releasedFromBatch: boolean;
}

export interface OrderView {
  orderNo: string;
  customer: string;
  phone: string;
  paidAt: string;
  inQueue: boolean;
  state: OrderState;
  stateText: string;
  product: { id: string; sku: string; name: string };
  queuePosition: number | null;
  aheadCount: number;
  waitingTotal: number;
  active: {
    id: string;
    batchNo: string;
    attempt: number;
    queuePosition: number;
    pickupDueAt: string;
    assignedAt: string;
    hoursLeft: number;
  } | null;
  history: AllocationHistoryItem[];
}

export interface QueueRow {
  id: string;
  orderNo: string;
  customer: string;
  phone: string;
  paidAt: string;
  inQueue: boolean;
  queuePosition: number | null;
  active: {
    id: string;
    batchNo: string;
    pickupDueAt: string;
    overdue: boolean;
  } | null;
  lastStatus: string | null;
}

export interface BatchView {
  id: string;
  batchNo: string;
  product: { id: string; name: string; sku: string };
  receivedQty: number;
  allocatedQty: number;
  remainingQty: number;
  paused: boolean;
  receiptNo: string;
  arrivedAt: string;
}

export interface NoticeRow {
  id: string;
  orderId: string;
  type: string;
  content: string;
  createdAt: string;
  order: { orderNo: string; customer: string };
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = Array.isArray(body.message) ? body.message.join('；') : body.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  products: () => req<Product[]>('/api/products'),
  queue: (productId: string) => req<QueueRow[]>(`/api/products/${productId}/queue`),
  batches: (productId?: string) =>
    req<BatchView[]>(`/api/batches${productId ? `?productId=${productId}` : ''}`),
  order: (orderNo: string) => req<OrderView>(`/api/orders/${encodeURIComponent(orderNo)}`),
  notifications: (orderNo?: string) =>
    req<NoticeRow[]>(`/api/notifications${orderNo ? `?orderNo=${encodeURIComponent(orderNo)}` : ''}`),
  placeOrder: (productId: string, customer: string, phone: string) =>
    req<OrderView>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ productId, customer, phone }),
    }),
  registerBatch: (
    productId: string,
    batchNo: string,
    receivedQty: number,
    receiptNo: string,
  ) =>
    req<{ duplicated: boolean }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify({ productId, batchNo, receivedQty, receiptNo }),
    }),
  setPaused: (id: string, paused: boolean) =>
    req<BatchView>(`/api/batches/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ paused }),
    }),
  act: (allocationId: string, action: 'pickup' | 'reject' | 'expire' | 'waive') =>
    req<OrderView>(`/api/allocations/${allocationId}/${action}`, { method: 'POST' }),
};

export function fmt(d: string | Date) {
  return new Date(d).toLocaleString('zh-CN', { hour12: false });
}
