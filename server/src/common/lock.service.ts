import { Injectable } from '@nestjs/common';

/**
 * 产品级互斥锁：同一产品的到货登记 / 取货 / 放弃 / 逾期回补 / 暂停恢复
 * 全部串行化，不同产品之间仍可并发。
 *
 * 这是“不超卖”的第一道防线（数据库里的条件 UPDATE 是第二道）：
 * 保证同一时刻只有一个分配事务在重算该产品的队列。
 */
@Injectable()
export class LockService {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(
      key,
      prev.then(
        () => gate,
        () => gate,
      ),
    );
    try {
      await prev;
      return await task();
    } finally {
      release();
    }
  }
}
