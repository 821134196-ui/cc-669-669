import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() body: { sku?: string; name?: string }) {
    const sku = body?.sku?.trim();
    const name = body?.name?.trim();
    if (!sku || !name) throw new BadRequestException('sku 和 name 必填');
    const existing = await this.prisma.product.findUnique({ where: { sku } });
    if (existing) return existing; // sku 幂等
    return this.prisma.product.create({ data: { sku, name } });
  }

  @Get()
  list() {
    return this.prisma.product.findMany({ orderBy: { createdAt: 'asc' } });
  }
}
