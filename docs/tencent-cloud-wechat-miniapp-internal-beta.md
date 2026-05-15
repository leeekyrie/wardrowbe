# Wardrowbe 部署到腾讯云 + 微信上传小程序并开放内测（Step by step）

> 适用：当前仓库（`backend/` FastAPI + `miniapp/` Taro）
>
> 目标：
> 1) 把后端部署到腾讯云（推荐 CloudBase 云托管）
> 2) 上传小程序代码并给内测用户体验

---

## 0. 先确认你要走哪条发布链路

- **链路 A（推荐，最稳）**：
  - 后端：腾讯云 CloudBase 云托管
  - 小程序上传：微信开发者工具手动上传
  - 内测：小程序后台设置体验版 + 体验成员

- **链路 B（自动化）**：
  - 你是“第三方平台服务商”模式（有开放平台代开发能力）
  - 用 OpenAPI 完成上传代码、绑定体验者、生成体验码

> 如果你不是第三方平台服务商，直接走链路 A。

---

## 1. 准备账号与资源

1. 腾讯云账号（开通 CloudBase）
2. 微信小程序账号（拿到 `AppID`）
3. 域名 1 个（用于后端 API）
4. TLS 证书（HTTPS）
5. 数据库与缓存：
   - PostgreSQL（建议腾讯云数据库 PostgreSQL）
   - Redis（建议腾讯云 Redis）
6. （可选）对象存储（后续如果切云端图片存储）

---

## 2. 后端生产配置（基于本仓库）

在你自己的生产环境变量里至少准备：

```env
# 必填
DATABASE_URL=postgresql+asyncpg://<user>:<pass>@<host>:5432/<db>
REDIS_URL=redis://<host>:6379/0
SECRET_KEY=<openssl rand -hex 32>

# 生产建议
DEBUG=false
CORS_ORIGINS=["https://<你的小程序业务域名>","https://<你的管理后台域名>"]

# AI
AI_BASE_URL=<你的AI服务地址>
AI_API_KEY=<key>
AI_VISION_MODEL=<model>
AI_TEXT_MODEL=<model>

# 天气（如果你启用）
QWEATHER_API_HOST=<host>
QWEATHER_API_KEY=<key>
QWEATHER_JWT=<jwt>
QWEATHER_LANG=zh

# 小程序登录（你要在微信环境里换 code 时）
WECHAT_MINIAPP_APPID=<你的小程序appid>
WECHAT_MINIAPP_SECRET=<你的小程序secret>
```

> 注意：不要在生产使用 `DEBUG=true + SECRET_KEY=change-me-in-production` 这类开发模式组合。

---

## 3. 构建并推送后端镜像

在仓库根目录：

```bash
# 1) 构建后端镜像
cd backend
docker build -t wardrowbe-backend:prod .

# 2) 打标签并推送到你的镜像仓库（TCR 或其他）
docker tag wardrowbe-backend:prod <你的镜像仓库>/wardrowbe-backend:prod
docker push <你的镜像仓库>/wardrowbe-backend:prod
```

> `backend/Dockerfile` 已包含运行所需依赖和 `uvicorn app.main:app` 启动命令，可直接用于容器部署。

---

## 4. 腾讯云 CloudBase 云托管部署

### 4.1 创建服务（backend）

在 CloudBase 云托管控制台：

1. 进入目标环境
2. 新建服务（Service 名称例如 `wardrowbe-backend`）
3. 镜像地址填你上一步推送的镜像
4. 端口填 `8000`
5. 配置环境变量（第 2 节那批）
6. 配置最小实例数（建议 >=1，避免冷启动影响）
7. 发布

### 4.2 创建服务（worker，可选但建议）

如果你要启用后台任务（ARQ worker）：

1. 再建一个服务 `wardrowbe-worker`
2. 同一镜像
3. 覆盖启动命令为：

```bash
arq app.workers.worker.WorkerSettings
```

4. 同步配置 `DATABASE_URL` / `REDIS_URL` 等环境变量

### 4.3 执行数据库迁移

你必须对生产数据库执行一次：

```bash
alembic upgrade head
```

可在 CI/CD job、运维跳板机，或临时任务容器里执行（只要连接的是生产库）。

---

## 5. 绑定 API 域名 + HTTPS

1. 给云托管（或 CloudBase HTTP 访问服务）绑定自定义域名
2. 配置 DNS 解析（通常 CNAME）
3. 配置/签发证书，确保 `https://api.xxx.com` 可访问
4. 健康检查：

```bash
curl https://api.xxx.com/api/v1/health
```

应返回健康状态。

---

## 6. 在微信侧配置服务器域名（关键）

在小程序后台（mp.weixin.qq.com）配置：

- 管理 → 开发管理 → 开发设置 → **服务器域名**
- 加入你的 API 域名（例如 `https://api.xxx.com`）

注意事项（会导致请求失败最常见）：

- 只能 HTTPS
- 不能用 IP / localhost
- 域名需备案

---

## 7. 构建并上传小程序代码

### 7.1 生产构建

```bash
cd miniapp
pnpm install

# 把 API 地址写入构建常量
TARO_APP_API_BASE_URL=https://api.xxx.com pnpm build:weapp
```

构建产物默认在：

```text
miniapp/dist
```

### 7.2 微信开发者工具上传（链路 A）

1. 打开微信开发者工具
2. 导入 `miniapp/dist`（或导入 miniapp 根目录按你工具习惯）
3. 选择正确 `AppID`
4. 本地预览确认网络请求都指向 `https://api.xxx.com`
5. 点击“上传”，填写版本号（例如 `0.1.0`）与备注

---

## 8. 开放给内测用户（体验版）

### 8.1 配置成员

- 在微信开发者平台/小程序后台，把同事加入开发者（或对应角色）
- 在体验版管理中添加体验成员（测试微信号）

### 8.2 下发体验

上传后，进入版本管理，把该开发版设为体验版，生成体验二维码。让内测用户微信扫码体验。

---

## 9. （可选）开放平台 API 自动化（链路 B）

> 仅适用于第三方平台代开发模式。

### 9.1 上传代码并生成体验版

调用 `wxa/commit`（commit）上传代码，会生成体验版。

### 9.2 绑定体验者

调用 `wxa/bind_tester` 把测试微信号加入体验成员。

### 9.3 获取体验二维码

调用 `wxa/get_qrcode` 获取体验版二维码，发给内测用户。

---

## 10. 上线前验收清单（建议照着打勾）

- [ ] `https://api.xxx.com/api/v1/health` 200
- [ ] 小程序已配置服务器域名
- [ ] 小程序请求全部走 HTTPS 且无跨域/域名报错
- [ ] 登录流程正常（非 401）
- [ ] 上传图片、生成推荐、核心路径可用
- [ ] 至少 2 位内测用户实际扫码体验通过

---

## 11. 常见故障速查

### Q1: 小程序请求直接失败（不是 401）
- 优先查服务器域名配置、HTTPS、备案状态。

### Q2: `{"detail":"Not authenticated"}`
- 请求没带 `Authorization: Bearer <token>`
- 或 token 过期/签名不一致（环境 SECRET_KEY 变化后旧 token 失效）

### Q3: 本地好好的，云上 500
- 优先查环境变量缺失（AI、DB、REDIS、WECHAT_*）
- 查看云托管日志与健康检查

---

## 12. 建议的最小发布顺序

1. 先部署后端到腾讯云（健康检查通过）
2. 再配微信服务器域名
3. 再上传小程序体验版
4. 最后开放体验成员

这样排顺序，定位问题最快。

## 新增：Style-Quiz Onboarding 内测检查

- [ ] 新账号首次登录会弹出“风格测评”阻塞弹窗
- [ ] 完成测评后自动解锁主流程
- [ ] 测评结果写入 `preferences`（`default_occasion/style_profile/color_*` 等）
- [ ] 老账号（已完成 onboarding）不会被阻塞
- [ ] 设置页可修改所有偏好字段，保存后生效

