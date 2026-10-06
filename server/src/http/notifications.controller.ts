import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
