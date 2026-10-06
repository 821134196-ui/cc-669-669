import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * 本地模拟通知：不落任何真实短信/邮件通道，
 * 只写入 Notification 表并打印到控制台，前端"通知日志"可直接查看。
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async send(type: string, orderId: string | null, payload: Record<string, unknown>) {
    const record = await this.prisma.notification.create({
      data: { type, orderId, payload: JSON.stringify(payload) },
    });
    console.log(`[mock-notify] ${type}`, JSON.stringify(payload));
    return record;
  }
}
