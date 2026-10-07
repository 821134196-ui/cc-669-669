import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

/** 本地模拟支付网关：下单即“支付成功”，返回网关流水号与成功时间 */
@Injectable()
export class PaymentService {
  async pay(amount?: number) {
    // 真实场景此处调用第三方支付回调；本地模拟为立即成功
    return {
      success: true as const,
      tradeNo: 'PAY' + Date.now().toString(36).toUpperCase() + randomBytes(3).toString('hex').toUpperCase(),
      paidAt: new Date(),
      amount: amount ?? 0,
    };
  }
}
