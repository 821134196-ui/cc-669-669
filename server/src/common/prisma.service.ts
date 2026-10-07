import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/// SQLite 相对路径在 CLI（相对 prisma/ 目录）与运行时（相对 cwd）下含义不同，
/// 这里统一解析到 server/prisma/*.db，避免 dev.db 落到两个位置。
export function resolveDbUrl(file = 'dev.db'): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // 编译后位于 server/dist/common，ts-node 下位于 server/src/common
  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');
  let dir = path.join(__dirname, '..', '..', 'prisma');
  if (!fs.existsSync(dir)) dir = path.join(process.cwd(), 'prisma');
  return `file:${path.join(dir, file)}`;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({
      datasources: { db: { url: resolveDbUrl() } },
      log: ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }
}
