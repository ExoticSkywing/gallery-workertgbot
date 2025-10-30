# Worker Gallery 部署完整指南

## 🎯 系统架构

```
用户发送图集链接
    ↓
Telegram Bot 解析
    ↓
yt-dlp 下载图片到服务器
    ↓
上传到 Telegraph 图床
    ↓
调用 Worker API 创建画廊
    ↓
用户收到两个按钮：
1. 🎨 在线画廊（Worker）
2. 📥 上传到群组（Telegram）
```

---

## 📋 部署步骤

### 第一步：部署 Cloudflare Worker

#### 1.1 安装 Wrangler CLI

```bash
npm install -g wrangler
```

#### 1.2 登录 Cloudflare

```bash
wrangler login
```

浏览器会打开 Cloudflare 授权页面，点击允许。

#### 1.3 创建 KV 命名空间

```bash
cd /root/data/test/image-gallery-worker
wrangler kv:namespace create KV
```

会返回类似这样的输出：
```
✨  Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "KV"
id = "abc123def456..."
```

#### 1.4 更新 wrangler.toml

复制上面的 `id`，替换 `wrangler.toml` 中的 `your-kv-namespace-id`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "abc123def456..."  # 替换为你的实际 ID
```

#### 1.5 部署 Worker

```bash
wrangler deploy
```

成功后会输出：
```
✨ Success! Uploaded worker image-gallery-worker
  https://image-gallery-worker.your-account.workers.dev
```

**记下这个 URL！**后面配置 Bot 时需要用到。

---

### 第二步：配置 Telegram Bot

#### 2.1 编辑 config.py

打开 `/root/data/docker_data/mirror-leech-telegram-bot/config.py`

找到第 132 行附近，修改 `WORKER_GALLERY_API`：

```python
# 把 Worker URL 填入这里（去掉末尾的斜杠）
WORKER_GALLERY_API = "https://image-gallery-worker.your-account.workers.dev"
```

#### 2.2 确保启用 Worker Gallery 模式

```python
USE_TELEGRAPH_FOR_GALLERY = True  # 必须为 True
```

#### 2.3 重启 Bot

```bash
cd /root/data/docker_data/mirror-leech-telegram-bot
docker-compose down
docker-compose up -d
```

或者如果使用 systemd：
```bash
systemctl restart mirrorbot
```

---

### 第三步：测试功能

#### 3.1 发送测试图集

在 Telegram 中向 Bot 发送一个图集链接，例如：
```
https://www.xiaohongshu.com/explore/12345678...
```

#### 3.2 预期结果

Bot 会回复：
```
✅ 图集已创建！

📸 共 30 张图片
📹 【图集标题】
👤 作者：XXX
⏱️ 耗时: 45秒

🌐 在线画廊：点击下方按钮查看
💡 国内外均可访问 · 有效期30天

📝 如需上传到群组，点击右侧按钮

[ 🎨 在线画廊 ] [ 📥 上传到群组 ]
```

#### 3.3 验证画廊

1. 点击 "🎨 在线画廊" 按钮
2. 应该打开一个精美的网页画廊
3. 所有图片都能正常加载
4. **国内也能访问**

---

## 🔍 故障排查

### 问题1：Worker 部署失败

```bash
# 检查 Wrangler 版本
wrangler --version  # 应该 >= 3.0

# 重新登录
wrangler logout
wrangler login

# 检查配置
cat wrangler.toml
```

### 问题2：Bot 提示 "WORKER_GALLERY_API 未配置"

检查 config.py：
```python
# 确保没有拼写错误
WORKER_GALLERY_API = "https://..."  # 注意去掉末尾的 /
```

### 问题3：画廊创建失败

查看 Bot 日志：
```bash
docker logs mirrorbot -f
```

或：
```bash
journalctl -u mirrorbot -f
```

常见错误：
- `API_ERROR`: Worker URL 配置错误
- `QUOTA_EXCEEDED`: 今日已创建1000个画廊

### 问题4：图片无法加载

1. 检查 Telegraph 图床上传是否成功（查看日志）
2. 访问 Worker `/health` 端点检查状态：
   ```
   https://your-worker.dev/health
   ```

### 问题5：配额超限

查看配额使用情况：
```bash
curl https://your-worker.dev/api/quota
```

如果超限，可以：
1. 等待第二天重置
2. 升级到付费版（$5/月，无限制）

---

## 📊 监控和维护

### 查看配额使用

在 Cloudflare Dashboard 中：
1. 进入 Workers & Pages
2. 选择 `image-gallery-worker`
3. 点击 `Metrics`
4. 查看请求数、错误率等

### 配额预警

可以在 Bot 中添加定时任务，每小时检查一次：

```python
# 在 bot 代码中添加
import aiohttp

async def check_worker_quota():
    async with aiohttp.ClientSession() as session:
        async with session.get('https://your-worker.dev/api/quota') as resp:
            data = await resp.json()
            
            if data['warning']:  # 达到 98%
                # 发送通知给管理员
                await send_admin_notification(
                    f"⚠️ Worker 配额预警：{data['percentage']}%"
                )
```

---

## 🚀 进阶：自定义域名

### 为什么要自定义域名？

- 更短更美观
- 品牌化
- 避免 workers.dev 被某些地区限速

### 配置步骤

1. 在 Cloudflare Dashboard 中：
   - 进入 Workers & Pages
   - 选择 `image-gallery-worker`
   - 点击 `Settings` → `Triggers`
   - 点击 `Add Custom Domain`
   - 输入域名（如 `gallery.yourdomain.com`）

2. 更新 Bot 配置：
   ```python
   WORKER_GALLERY_API = "https://gallery.yourdomain.com"
   ```

3. 重启 Bot

---

## 💰 成本分析

### 免费版（推荐开始使用）

| 项目 | 限制 | 足够吗？ |
|------|------|---------|
| 每天画廊创建 | 1,000 个 | ✅ 100用户×10画廊 |
| 存储画廊数 | 30,000 个（30天） | ✅ 够用 |
| 每天读取 | 100,000 次 | ✅ 够用 |

### 付费版（$5/月）

- ✅ 无限请求
- ✅ 无限写入
- ✅ 50ms CPU 时间
- ✅ 适合大规模用户

### 何时升级？

- 每天用户超过 100 人
- 每天画廊创建接近 1,000 个
- 需要更好的性能

---

## 📝 注意事项

1. **画廊有效期**：30 天后自动清理
2. **Telegraph 图床**：图片永久保存
3. **国内访问**：完全可以访问
4. **用户体验**：两个按钮满足不同需求

---

## ✅ 检查清单

部署完成后，检查以下项目：

- [ ] Worker 已成功部署
- [ ] KV 命名空间已绑定
- [ ] Bot config.py 已配置 WORKER_GALLERY_API
- [ ] Bot 已重启
- [ ] 测试图集链接正常工作
- [ ] 画廊页面国内可访问
- [ ] 图片能正常加载
- [ ] 两个按钮都能正常工作

---

## 🆘 获取帮助

如遇到问题：

1. 查看 Bot 日志
2. 查看 Worker 日志（Cloudflare Dashboard → Logs）
3. 检查配置文件
4. 参考本文档的故障排查部分

---

**部署成功后，您的用户将获得极致的图集浏览体验！** 🎉


用户发送图集链接
    ↓
Bot: yt-dlp 解析图片列表
    ↓
Bot: 下载所有图片到服务器
    ↓
Bot: 上传到 Catbox.moe（永久免费）
    ↓
Bot: 获得 Catbox URL 列表
    ["https://files.catbox.moe/abc123.jpg", ...]
    ↓
Bot: 调用 Worker API
    POST /api/create-gallery
    { images: [...] }
    ↓
Worker: 存储到 KV（30天）
    ↓
Worker: 返回画廊 URL
    https://your-worker.dev/gallery/xyz
    ↓
用户点击 → 查看画廊
    GET /gallery/xyz
    ↓
Worker: 生成 HTML 页面
    <img src="https://files.catbox.moe/abc123.jpg">
    ↓
用户浏览器: 直接从 Catbox CDN 加载图片 ✅