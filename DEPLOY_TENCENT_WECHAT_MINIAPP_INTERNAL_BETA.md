# Wardrowbe：腾讯云部署 + 微信上传小程序并开放内测（完整 Step-by-step）

> 更新时间：2026-05-07  
> 适用仓库：`wardrowbe`（`backend/` FastAPI + `miniapp/` Taro）
>
> 本文目标：
> 1. 把后端服务部署到腾讯云（以 **CloudBase 云托管** 为主路径）
> 2. 在微信侧上传小程序代码
> 3. 把版本开放给内测用户（体验版）

---

## 0. 先看部署路径（建议直接用路径 A）

### 路径 A（推荐）
- 后端：腾讯云 CloudBase 云托管（API + Worker 两个服务）
- 上传小程序：微信开发者工具手工上传
- 内测：微信公众平台设置体验版 + 添加体验成员

### 路径 B（自动化）
- 你是第三方平台（微信开放平台代开发模式）
- 用 OpenAPI 自动提交代码、绑定体验者、发体验二维码

> 如果你不是“第三方平台服务商”，直接走路径 A。

---

## 1. 发布前准备清单（必须）

### 1.1 账号与权限
- [ ] 腾讯云账号（已开通 CloudBase）
- [ ] 微信小程序账号（有管理员/开发者权限）
- [ ] 微信开发者工具可登录目标小程序
- [ ] 项目可正常本地构建

### 1.2 基础资源
- [ ] 一个可用域名（用于 API，如 `api.example.com`）
- [ ] HTTPS 证书（腾讯云 SSL 或其他）
- [ ] 中国大陆环境下完成 ICP 备案
- [ ] PostgreSQL（建议腾讯云 TDSQL-C PostgreSQL）
- [ ] Redis（建议腾讯云 Redis）

### 1.3 你需要准备的关键参数

| 参数 | 示例 | 用途 |
|---|---|---|
| `CLOUDBASE_ENV_ID` | `prod-abc123` | 云托管环境 ID |
| `CLOUDBASE_SERVICE` | `wardrowbe-api` | 小程序 callContainer 服务名 |
| `API_DOMAIN` | `https://api.example.com` | 小程序直连 API 场景 |
| `DATABASE_URL` | `postgresql+asyncpg://...` | 后端数据库连接 |
| `REDIS_URL` | `redis://...` | 任务队列 |
| `SECRET_KEY` | `openssl rand -hex 32` 生成 | JWT 签名 |
| `WECHAT_MINIAPP_APPID` | `wx123...` | 小程序登录换取 openid |
| `WECHAT_MINIAPP_SECRET` | `xxxxx` | 小程序登录密钥 |

---

## 2. Step 1：准备后端运行配置（本仓库）

在项目根目录复制环境文件：

```bash
cp .env.example .env.prod
```

编辑 `.env.prod`（至少确保以下字段正确）：

```env
# 核心
SECRET_KEY=<openssl rand -hex 32>
DATABASE_URL=postgresql+asyncpg://<user>:<pass>@<host>:5432/<db>
REDIS_URL=redis://<host>:6379/0

# AI
AI_BASE_URL=<your-openai-compatible-endpoint>
AI_API_KEY=<your-key>
AI_VISION_MODEL=<vision-model>
AI_TEXT_MODEL=<text-model>

# 天气（如使用）
QWEATHER_API_HOST=<host>
QWEATHER_API_KEY=<key>
QWEATHER_JWT=<jwt>
QWEATHER_LANG=zh

# 小程序登录
WECHAT_MINIAPP_APPID=<your-appid>
WECHAT_MINIAPP_SECRET=<your-miniapp-secret>

# 云托管对象存储（建议）
STORAGE_BACKEND=cloudbase
CLOUDBASE_ENV_ID=<your-env-id>
CLOUDBASE_STORAGE_BUCKET=<your-bucket>
```

> 注意：生产不要使用默认 `SECRET_KEY=change-me-in-production...`。

---

## 3. Step 2：构建并推送镜像（API + Worker）

下面命令在 **项目根目录** 执行。建议推送到腾讯云 TCR。

```bash
# 0) 替换你的镜像仓库地址
export REGISTRY=<你的TCR仓库地址>
export TAG=v0.1.0

# 1) 构建 API 镜像（使用 cloudbase/api.Dockerfile）
docker build -f cloudbase/api.Dockerfile -t ${REGISTRY}/wardrowbe-api:${TAG} .

# 2) 构建 Worker 镜像（使用 cloudbase/worker.Dockerfile）
docker build -f cloudbase/worker.Dockerfile -t ${REGISTRY}/wardrowbe-worker:${TAG} .

# 3) 登录并推送
# docker login ${REGISTRY}
docker push ${REGISTRY}/wardrowbe-api:${TAG}
docker push ${REGISTRY}/wardrowbe-worker:${TAG}
```

---

## 4. Step 3：在 CloudBase 云托管创建服务

进入 CloudBase 控制台 -> 目标环境 -> 云托管。

### 4.1 创建 API 服务（`wardrowbe-api`）
1. 新建服务
2. 镜像：`${REGISTRY}/wardrowbe-api:${TAG}`
3. 容器端口：`8000`
4. 环境变量：填入第 2 步里的生产变量
5. 资源建议：`0.5C~1C / 1G~2G` 起步
6. 最小实例建议：`1`（避免冷启动影响首屏请求）
7. 发布

### 4.2 创建 Worker 服务（`wardrowbe-worker`）
1. 新建服务
2. 镜像：`${REGISTRY}/wardrowbe-worker:${TAG}`
3. 启动命令使用镜像默认（`arq app.workers.worker.WorkerSettings`）
4. 环境变量与 API 服务保持一致（至少 DB/Redis/SECRET_KEY/AI）
5. 最小实例建议：`1`（**不要缩容到 0**，否则定时任务与后台任务会停）
6. 发布

---

## 5. Step 4：执行数据库迁移

确保对生产数据库执行一次迁移：

```bash
# 方式示例：在可访问生产 DB 的环境里执行
cd backend
export DATABASE_URL='postgresql+asyncpg://<user>:<pass>@<host>:5432/<db>'
alembic upgrade head
```

如果你通过云托管执行一次性任务，也要保证使用的是生产 `DATABASE_URL`。

---

## 6. Step 5：绑定域名与 HTTPS

目标：让 API 最终可通过 `https://api.example.com` 访问。

1. 在云托管绑定自定义域名
2. DNS 配置 CNAME/解析（按控制台提示）
3. 绑定 SSL 证书
4. 验证健康检查

```bash
curl -i https://api.example.com/api/v1/health
```

预期：HTTP 200 且返回健康 JSON。

---

## 7. Step 6：微信侧配置“服务器域名”

进入微信公众平台（小程序后台）：

**管理 -> 开发管理 -> 开发设置 -> 服务器域名**

添加业务请求域名（request）：
- `https://api.example.com`

注意：
- 必须 HTTPS
- 不能配置 IP / localhost
- 中国大陆通常要求备案
- 如果你填了端口，请求也必须带同端口

---

## 8. Step 7：构建小程序产物

### 8.1 校验 `AppID`
检查 `miniapp/project.config.json`：
- 把 `appid` 从 `touristappid` 改为真实小程序 AppID。

### 8.2 生产构建
在项目根目录执行：

```bash
cd miniapp
pnpm install

# 推荐：走 HTTPS 域名直连 API
TARO_APP_API_BASE_URL=https://api.example.com pnpm build:weapp
```

构建产物目录：`miniapp/dist`

> 可选：如果你要走云托管 `callContainer` 直连，把 `TARO_APP_CLOUDBASE_ENV_ID` 和 `TARO_APP_CLOUDBASE_SERVICE` 也写入构建环境。

---

## 9. Step 8：微信开发者工具上传代码

1. 打开微信开发者工具
2. 导入项目（推荐导入 `miniapp` 目录，`miniprogramRoot` 已配置为 `dist/`）
3. 选择正确 AppID
4. 真机预览验证核心流程
5. 点击“上传”
6. 填写版本号（如 `0.1.0`）与备注（如 `cloudbase api deploy + bugfix`）

上传成功后，去微信公众平台可看到“开发版本”。

---

## 10. Step 9：设置体验版并开放内测用户

1. 微信公众平台 -> 版本管理 -> 开发版本
2. 选择刚上传版本，设为体验版
3. 添加体验成员（微信号）
4. 生成体验二维码
5. 将二维码发给内测用户扫码体验

建议至少覆盖以下回归：
- [ ] 登录/鉴权
- [ ] 衣橱列表与详情
- [ ] 上传图片
- [ ] AI 分析与推荐
- [ ] 天气相关功能
- [ ] 通知链路（如果开启）

---

## 11. Step 10：上线前验收与回滚预案

### 11.1 上线验收清单
- [ ] `https://api.example.com/api/v1/health` 正常
- [ ] 小程序服务器域名已生效
- [ ] 小程序请求没有“合法域名”报错
- [ ] 核心接口无 401/500
- [ ] CloudBase API/Worker 日志无持续异常

### 11.2 建议回滚方案
- 镜像按 tag 管理（如 `v0.1.0`, `v0.1.1`）
- 出问题时把 API/Worker 镜像回切到上一个稳定 tag
- 小程序体验版保留上一个可用版本，先回退再排障

---

## 12. 常见问题排查（高频）

### Q1：小程序报“request:fail url not in domain list”
- 检查公众平台服务器域名是否已添加且生效
- 检查请求 URL 是否与配置完全一致（协议/端口）

### Q2：后端返回 401
- 小程序 token 丢失/过期
- 后端 `SECRET_KEY` 变更导致旧 token 失效
- 登录流程是否已调用 `/api/v1/auth/wechat-miniapp/sync`

### Q3：后端 500
- 先查 CloudBase 日志
- 高概率是环境变量缺失（DB/Redis/AI/WECHAT_MINIAPP_*）
- 确认数据库迁移是否执行

### Q4：小程序能打开但 API 一直超时
- 检查 API 最小实例数是否为 0（冷启动慢）
- 检查安全策略、外网访问策略和 DNS
- 检查 AI 请求超时时间与模型响应速度

---

## 13. （可选）微信开放平台自动化发布（路径 B）

仅在你具备“第三方平台代开发”权限时使用。

典型流程：
1. 调用 `commit` 上传代码生成体验版
2. 调用 `bind_tester` 绑定体验者
3. 调用获取二维码接口下发体验码
4. 后续提交审核、发布

> 这条链路更适合多租户 SaaS 场景，不是单小程序团队的必选项。

---

## 14. 一页式执行顺序（建议按此顺序）

1. 准备腾讯云资源（DB/Redis/域名/证书）  
2. 准备 `.env.prod`（含 WECHAT_MINIAPP_*）  
3. 构建并推送 API/Worker 镜像到 TCR  
4. CloudBase 发布 API/Worker 服务  
5. 执行 `alembic upgrade head`  
6. 验证 `https://api.example.com/api/v1/health`  
7. 微信公众平台配置服务器域名  
8. `miniapp` 生产构建并上传代码  
9. 设置体验版 + 添加体验成员 + 发二维码  
10. 完成内测回归并准备正式提审  

---

如果你希望，我可以在下一步直接给你生成一份 **可填写的发布模板**（含“参数表 + 版本记录 + 发布验收记录 + 回滚记录”），你每次发版只要替换变量即可。

## 新增：Style-Quiz Onboarding 内测检查

- [ ] 新账号首次登录会弹出“风格测评”阻塞弹窗
- [ ] 完成测评后自动解锁主流程
- [ ] 测评结果写入 `preferences`（`default_occasion/style_profile/color_*` 等）
- [ ] 老账号（已完成 onboarding）不会被阻塞
- [ ] 设置页可修改所有偏好字段，保存后生效

