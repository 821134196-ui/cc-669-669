# 预订到货批次分配系统

电商商品预订的到货批次分配系统：运营登记实收到货批次，系统按**付款成功时间**自动分货（同一时间付款按订单号稳定排序，无人工插队入口），客户可查询自己的等待顺位、分到的批次与取货期限。

## 技术栈

- **后端**：TypeScript + NestJS + Prisma + SQLite（`server/`，端口 3001）
- **前端**：React + Vite（`web/`，端口 5173，`/api` 代理到后端）
- **通知 / 支付**：本地模拟（通知写库 + 控制台输出；创建订单即视为支付成功）

## 快速开始

```bash
npm install     # 安装根/后端/前端依赖（postinstall 自动级联，并生成 Prisma Client）
npm run dev     # 一条命令同时启动前后端
```

打开 http://127.0.0.1:5173 （如端口被占用，Vite 会提示新端口）。

可选演示数据：`npm run seed`（1 个商品 + 3 笔排队订单）。

## 验证

```bash
npm test        # Jest + 真实 SQLite 临时库：6 个关键场景测试
npm run smoke   # 端到端冒烟（需 npm run dev 已启动），走一遍完整业务流
```

测试覆盖（`server/test/allocation.spec.ts`）：

1. **并发分货不超卖**：10 个并发分配请求，5 件库存只分出 5 件
2. **同一时间付款按订单号稳定排序**
3. **逾期未取**：库存回补原批次、订单取消、自动通知下一顺位
4. **放弃本批次**：订单保留后续排队资格，下一批次到货仍按原顺位分配
5. **质检暂停**：暂停期间不参与分配，恢复后立即补充分配
6. **重复到货回执**：顺序重复 + 并发重复都只入库一次

## 业务规则

- **分货顺序**：仅由 `(paidAt, orderNo)` 决定（付款时间升序，同时间按订单号字典序），系统没有提供任何调整顺位的接口。
- **并发安全**：批次库存通过条件更新 `allocatedQty + 1 WHERE allocatedQty < receivedQty` 原子占位；订单通过 `status: QUEUED → ALLOCATED` 条件更新原子锁定。SQLite 单连接串行化（`connection_limit=1`），双重保证不超卖、不重复分配。
- **取货期限**：分配成功即生成截止时间（`PICKUP_WINDOW_SECONDS`，默认 1800 秒），后台扫描器（`SWEEP_INTERVAL_MS`，默认 5 秒）周期性关闭逾期分配。
- **逾期 / 拒收**：库存退回**原批次**（`allocatedQty - 1`），订单取消并记录原因，立即通知该批次下一顺位。
- **放弃本批次**：库存退回原批次，写入 `BatchSkip` 记录，订单保持 `QUEUED`；该订单不再参与此批次，但后续批次仍按原顺位参与分配。
- **质检暂停**：`QC_PAUSED` 批次不参与任何分配；恢复（`ACTIVE`）后立即对队列补充分配。
- **回执幂等**：`receiptId` 有唯一约束，重复（含并发重复）回执返回已有批次，绝不重复增加库存。

## 页面

- **运营台**：商品管理、到货登记（回执幂等）、批次列表（实收/已分配/可分配/质检暂停与恢复）、预订队列（含顺位）、分配记录、通知日志、手动扫描逾期
- **客户端**：模拟支付下单（可指定付款时间以演示同时间排序）、订单查询——展示**顺位、批次、取货期限倒计时、放弃本批后的状态**，以及确认取货 / 放弃本批次 / 拒收操作

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/products` | 创建商品（sku 幂等） |
| GET | `/api/products` | 商品列表 |
| POST | `/api/orders` | 创建订单（模拟支付成功），可选 `paidAt`/`orderNo` |
| GET | `/api/orders` | 订单列表（含顺位） |
| GET | `/api/orders/:orderNo` | 订单详情：顺位、当前分配、已放弃批次、历史 |
| POST | `/api/batches` | 登记到货批次（`receiptId` 幂等） |
| GET | `/api/batches` | 批次列表 |
| POST | `/api/batches/:id/pause` `/resume` | 质检暂停 / 恢复 |
| GET | `/api/allocations` | 分配记录 |
| POST | `/api/allocations/:id/pickup` `/reject` `/give-up` | 取货 / 拒收 / 放弃本批 |
| POST | `/api/allocations/sweep-expired` | 手动触发逾期扫描 |
| GET | `/api/notifications` | 模拟通知日志 |

## 配置（`server/.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db?connection_limit=1` | SQLite 连接 |
| `PORT` | `3001` | API 端口 |
| `PICKUP_WINDOW_SECONDS` | `1800` | 取货期限 |
| `SWEEP_INTERVAL_MS` | `5000` | 逾期扫描间隔 |

## 目录结构

```
├── package.json            # 根脚本：npm run dev 一条命令起前后端
├── scripts/smoke.mjs       # 端到端冒烟脚本
├── server/                 # NestJS + Prisma
│   ├── prisma/schema.prisma# 数据模型（Batch.receiptId 唯一 = 回执幂等键）
│   ├── src/allocation/     # 分配引擎 + 逾期扫描器
│   ├── src/http/           # REST 控制器
│   └── test/               # 关键场景测试
└── web/                    # React + Vite（运营台 / 客户端两个视图）
```

> 注：本环境 npm 官方源不可达，仓库根目录 `.npmrc` 指向 npmmirror 镜像；网络正常的环境可删除该文件。
