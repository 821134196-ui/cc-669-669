import type { Allocation, Batch, NotificationItem, Order, OrderDetail, Product } from './types';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  // 商品
  products: () => req<Product[]>('/products'),
  createProduct: (b: { sku: string; name: string }) => post<Product>('/products', b),
  // 批次
  batches: () => req<Batch[]>('/batches'),
  registerBatch: (b: { productId: string; receivedQty: number; receiptId: string; batchNo?: string }) =>
    post<{ batch: Batch; duplicated: boolean }>('/batches', b),
  pauseBatch: (id: string) => post<Batch>(`/batches/${id}/pause`),
  resumeBatch: (id: string) => post<Batch>(`/batches/${id}/resume`),
  // 订单
  createOrder: (b: { productId: string; customer: string; paidAt?: string }) =>
    post<Order>('/orders', b),
  orders: (productId?: string) => req<Order[]>(`/orders${productId ? `?productId=${productId}` : ''}`),
  orderDetail: (orderNo: string) => req<OrderDetail>(`/orders/${encodeURIComponent(orderNo)}`),
  // 分配
  allocations: () => req<Allocation[]>('/allocations'),
  pickup: (id: string) => post<{ ok: boolean }>(`/allocations/${id}/pickup`),
  reject: (id: string) => post<{ ok: boolean }>(`/allocations/${id}/reject`),
  giveUp: (id: string) => post<{ ok: boolean }>(`/allocations/${id}/give-up`),
  sweepExpired: () => post<{ swept: number }>('/allocations/sweep-expired'),
  // 通知
  notifications: () => req<NotificationItem[]>('/notifications'),
};
