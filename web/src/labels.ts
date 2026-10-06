export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const ORDER_STATUS: Record<string, { text: string; cls: string }> = {
  QUEUED: { text: '排队中', cls: 'tag-blue' },
  ALLOCATED: { text: '已分配待取货', cls: 'tag-green' },
  FULFILLED: { text: '已取货', cls: 'tag-gray' },
  CANCELLED: { text: '已取消', cls: 'tag-red' },
};

export const ALLOCATION_STATUS: Record<string, { text: string; cls: string }> = {
  PENDING_PICKUP: { text: '待取货', cls: 'tag-green' },
  PICKED_UP: { text: '已取货', cls: 'tag-gray' },
  EXPIRED: { text: '逾期未取', cls: 'tag-red' },
  REJECTED: { text: '已拒收', cls: 'tag-red' },
  GIVEN_UP: { text: '客户放弃本批', cls: 'tag-orange' },
};

export const BATCH_STATUS: Record<string, { text: string; cls: string }> = {
  ACTIVE: { text: '可分配', cls: 'tag-green' },
  QC_PAUSED: { text: '质检暂停', cls: 'tag-red' },
};

export const NOTIFY_TYPE: Record<string, string> = {
  PAYMENT_SUCCESS: '支付成功',
  ALLOCATED: '分配成功',
  PICKED_UP: '取货完成',
  EXPIRED: '逾期取消',
  REJECTED: '拒收',
  GIVEN_UP: '放弃本批',
};

export const CANCEL_REASON: Record<string, string> = {
  EXPIRED: '逾期未取',
  REJECTED: '拒收',
};
