import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export type NoticeType = 'ASSIGNED' | 'PICKED_UP' | 'EXPIRED' | 'REJECTED' | 'WAIVED';

/** 本地模拟通知：写库（前端轮询可见）+ 服务端日志打印“短信” */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(private readonly prisma: PrismaService) {}

  async send(orderId: string, type: NoticeType, content: string) {
    const row = await this.prisma.notification.create({
      data: { orderId, type, content },
      include: { order: { include: { product: true } } },
    });
    this.logger.log(
      `[模拟短信 → ${row.order.customer}/${row.order.phone}] (${type}) ` +
        `订单 ${row.order.orderNo} · ${row.order.product.name}：${content}`,
    );
    return row;
  }
}
