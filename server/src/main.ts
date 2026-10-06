import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableCors();
  app.setGlobalPrefix('api');
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`API 服务已启动: http://localhost:${port}/api`);
}

bootstrap();
