import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AllocationService } from './allocation.service';

/** 逾期取货扫描器：周期性把超时未取的分配关闭并回补库存 */
@Injectable()
export class ExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private readonly allocation: AllocationService) {}

  onModuleInit() {
    const interval = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
    this.timer = setInterval(() => {
      this.allocation.sweepExpired().catch((e) => console.error('[sweeper] 扫描失败', e));
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
