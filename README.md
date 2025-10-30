# Image Gallery Worker

为 mirrorbot 提供图集画廊服务，解决 Telegraph 国内访问问题。

**图片托管：** Catbox.moe（免费、永久、无限制、国内可访问）

## 功能特性

- ✅ 国内外均可访问的图集画廊
- ✅ 精美的瀑布流布局
- ✅ 图片灯箱查看
- ✅ 单张图片下载
- ✅ 自动过期清理（30天）
- ✅ 配额监控和预警

## 快速部署

### 1. 安装 Wrangler

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 KV 命名空间

```bash
wrangler kv:namespace create KV
```

复制返回的 ID，替换 `wrangler.toml` 中的 `your-kv-namespace-id`

### 4. 部署

```bash
wrangler deploy
```

部署成功后会得到 Worker URL，例如：
```
https://image-gallery-worker.your-account.workers.dev
```

## API 文档

### 1. 创建画廊

**请求：**
```http
POST /api/create-gallery
Content-Type: application/json

{
  "title": "图集标题",
  "author": "作者名",
  "images": [
    "https://files.catbox.moe/abc123.jpg",
    "https://files.catbox.moe/def456.jpg"
  ]
}
```

**响应（成功）：**
```json
{
  "success": true,
  "gallery_url": "https://your-worker.dev/gallery/l8xm7k2pq5x9",
  "id": "l8xm7k2pq5x9",
  "expires_in_days": 30
}
```

**响应（配额用完）：**
```json
{
  "success": false,
  "error": "QUOTA_EXCEEDED",
  "message": "今日画廊创建已达上限，请明天再试"
}
```

### 2. 查看画廊

```http
GET /gallery/{id}
```

返回精美的 HTML 画廊页面

### 3. 配额查询

```http
GET /api/quota
Authorization: Bearer your-admin-token
```

**响应：**
```json
{
  "date": "2025-10-30",
  "used": 850,
  "limit": 1000,
  "remaining": 150,
  "percentage": "85.0",
  "warning": false
}
```

## 配额限制

- **每天最多创建：** 1,000 个画廊
- **存储容量：** 最多 100,000 个画廊
- **画廊有效期：** 30 天自动过期
- **预警阈值：** 98%（980 个）

## 监控建议

可以在 mirrorbot 中定期调用 `/api/quota` 接口：

```python
# 每小时检查一次
response = await get_worker_quota()
if response['warning']:  # 达到 98%
    await notify_admin(f"⚠️ 画廊配额预警：{response['percentage']}%")
```

## 自定义域名（可选）

在 Cloudflare Dashboard 中：

1. 进入 Workers & Pages
2. 选择 `image-gallery-worker`
3. 点击 `Settings` → `Triggers`
4. 添加自定义域名（如 `gallery.yourdomain.com`）

## 故障排查

### Worker 部署失败
```bash
# 检查 Wrangler 版本
wrangler --version

# 重新登录
wrangler logout
wrangler login
```

### KV 写入失败
- 检查 KV 命名空间 ID 是否正确
- 检查是否达到每日写入限制（1,000次）

### 图片无法加载
- 确认 Catbox 图床 URL 是否正确
- Catbox 图片永久有效，不会过期

## 许可证

MIT License


