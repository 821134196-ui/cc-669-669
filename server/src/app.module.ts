import { Module } from '@nestjs/common';
import { AllocationModule } from './allocation/allocation.module';

@Module({
  imports: [AllocationModule],
})
export class AppModule {}
