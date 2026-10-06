export type BatchStatus = 'ACTIVE' | 'QC_PAUSED';
export type OrderStatus = 'QUEUED' | 'ALLOCATED' | 'FULFILLED' | 'CANCELLED';
export type AllocationStatus = 'PENDING_PICKUP' | 'PICKED_UP' | 'EXPIRED' | 'REJECTED' | 'GIVEN_UP';

export interface Product {
  id: string;
  sku: string;
  name: string;
  createdAt: string;
}

export interface Batch {
  id: string;
  productId: string;
  batchNo: string;
  receiptId: string;
  receivedQty: number;
  allocatedQty: number;
  status: BatchStatus;
  createdAt: string;
  product?: Product;
}

export interface Order {
  id: string;
  orderNo: string;
  productId: string;
  customer: string;
  paidAt: string;
  status: OrderStatus;
  cancelReason: string | null;
  createdAt: string;
  product?: Product;
  position?: number | null;
}

export interface Allocation {
  id: string;
  batchId: string;
  orderId: string;
  status: AllocationStatus;
  deadline: string;
  createdAt: string;
  closedAt: string | null;
  batch?: Batch;
  order?: Order;
}

export interface OrderDetail {
  order: Order & {
    allocations: (Allocation & { batch: Batch })[];
  };
  position: number | null;
  currentAllocation: (Allocation & { batch: Batch }) | null;
  skippedBatches: { batchNo: string; at: string }[];
}

export interface NotificationItem {
  id: string;
  orderId: string | null;
  type: string;
  payload: string;
  createdAt: string;
}
