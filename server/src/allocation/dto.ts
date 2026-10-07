import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsString()
  @MinLength(1)
  name!: string;
}

export class PlaceOrderDto {
  @IsString()
  @MinLength(1)
  productId!: string;

  @IsString()
  @MinLength(1)
  customer!: string;

  @IsString()
  @MinLength(5)
  phone!: string;
}

export class RegisterBatchDto {
  @IsString()
  @MinLength(1)
  productId!: string;

  @IsString()
  @MinLength(1)
  batchNo!: string;

  @IsInt()
  @Min(1)
  receivedQty!: number;

  /// 到货回执单号：幂等键，重复回执不会再次增加库存
  @IsString()
  @MinLength(1)
  receiptNo!: string;
}

export class UpdateBatchDto {
  @IsBoolean()
  paused!: boolean;
}

export class NotificationQueryDto {
  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
