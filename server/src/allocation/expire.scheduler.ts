import { Injectable, OnModuleInit } from '@nestjs/common';
import { AllocationEngine } from './allocation.engine';

/**
 * 每 30 秒扫描超过取货期限未取货的分配：
 * 退回原批次 → 通知下一顺位客户。
 * 页面上也提供“模拟逾期”按钮，不必等待真实 48 小时。
 */
@Injectable()
export class ExpireScheduler implements OnModuleInit {
  private timer?: NodeJS.Timeout;

  constructor(private readonly engine: AllocationEngine) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.engine.expireDue().catch(() => undefined);
    }, 30_000);
  }
}
