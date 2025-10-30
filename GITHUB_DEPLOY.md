# 通过 GitHub 部署 Worker 完整指南

## 📋 准备工作

✅ Git 仓库已初始化
✅ 代码已提交

---

## 🚀 部署步骤

### 第一步：在 GitHub 创建仓库

1. 打开 https://github.com/new
2. 填写仓库信息：
   - **Repository name:** `image-gallery-worker`
   - **Description:** `Image Gallery Worker for Telegram Bot - 国内可访问的图集画廊服务`
   - **Visibility:** 
     - ✅ **Private**（推荐，保护配置）
     - 或 Public（开源）
   - ⚠️ **不要勾选** "Add a README file"
   - ⚠️ **不要勾选** "Add .gitignore"

3. 点击 **Create repository**

4. 复制仓库 URL（显示在页面上）：
   ```
   https://github.com/your-username/image-gallery-worker.git
   ```

---

### 第二步：Push 代码到 GitHub

在服务器上执行：

```bash
cd /root/data/test/image-gallery-worker

# 添加远程仓库（替换为你的实际 URL）
git remote add origin https://github.com/YOUR-USERNAME/image-gallery-worker.git

# 如果使用 Personal Access Token (推荐):
# git remote set-url origin https://YOUR_TOKEN@github.com/YOUR-USERNAME/image-gallery-worker.git

# Push 代码
git branch -M main
git push -u origin main
```

**认证方式：**

**方案 A：Personal Access Token（推荐）**
1. GitHub 设置 → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token (classic)
3. 勾选 `repo` 权限
4. 生成后复制 Token
5. 使用 Token 作为密码 Push

**方案 B：SSH Key**
```bash
# 生成 SSH Key（如果没有）
ssh-keygen -t ed25519 -C "your_email@example.com"

# 复制公钥
cat ~/.ssh/id_ed25519.pub

# 添加到 GitHub: Settings → SSH and GPG keys → New SSH key

# 使用 SSH URL
git remote set-url origin git@github.com:YOUR-USERNAME/image-gallery-worker.git
git push -u origin main
```

---

### 第三步：在 Cloudflare 部署

#### 3.1 登录 Cloudflare Dashboard

打开：https://dash.cloudflare.com/

#### 3.2 创建 Pages 项目

1. 左侧菜单 → **Workers & Pages**
2. 点击 **Create application**
3. 选择 **Pages** 标签
4. 点击 **Connect to Git**

#### 3.3 连接 GitHub

1. 如果第一次使用，点击 **Connect GitHub**
2. 授权 Cloudflare 访问你的 GitHub 账号
3. 选择：
   - **All repositories**（所有仓库）
   - 或 **Only select repositories** → 选择 `image-gallery-worker`
4. 点击 **Install & Authorize**

#### 3.4 配置项目

1. 选择仓库：`image-gallery-worker`
2. 点击 **Begin setup**
3. 配置构建设置：
   - **Project name:** `image-gallery-worker`（或自定义）
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** 留空
   - **Build output directory:** `/`

4. 点击 **Save and Deploy**

#### 3.5 配置 KV 命名空间

部署完成后：

1. 进入项目 → **Settings** → **Functions**
2. 滚动到 **KV namespace bindings**
3. 点击 **Add binding**
4. 填写：
   - **Variable name:** `KV`
   - **KV namespace:** 
     - 如果已有：选择现有的
     - 如果没有：点击 **Create a new namespace**
       - Name: `image-gallery-kv`
       - 点击 **Add**
5. 点击 **Save**

#### 3.6 重新部署

配置 KV 后需要重新部署：

1. 进入项目 → **Deployments**
2. 找到最新的部署
3. 点击右侧的 **···** → **Retry deployment**

或者直接 Push 新代码触发自动部署。

---

### 第四步：获取 Worker URL

部署成功后：

1. 在 Cloudflare Pages 项目页面
2. 可以看到部署的 URL：
   ```
   https://image-gallery-worker.pages.dev
   ```
   或者自定义域名

3. **复制这个 URL**，后面配置 Bot 时需要用到

---

### 第五步：测试 Worker

访问以下 URL 测试：

```bash
# 健康检查
curl https://your-project.pages.dev/health

# 预期返回：
{
  "status": "ok",
  "service": "Image Gallery Worker",
  "timestamp": "2025-10-30T..."
}
```

---

## 🔄 后续更新流程

每次修改代码后：

```bash
cd /root/data/test/image-gallery-worker

# 查看修改
git status

# 添加修改
git add .

# 提交
git commit -m "描述你的修改"

# Push（自动触发部署）
git push
```

Cloudflare 会自动：
1. 检测到 Push
2. 拉取最新代码
3. 自动部署
4. 通常 1-2 分钟完成

---

## 🎯 配置 Bot

在 `/root/data/docker_data/mirror-leech-telegram-bot/config.py` 中：

```python
# 填入 Cloudflare Pages 给你的 URL
WORKER_GALLERY_API = "https://image-gallery-worker.pages.dev"
```

然后重启 Bot：
```bash
cd /root/data/docker_data/mirror-leech-telegram-bot
docker-compose down && docker-compose up -d
```

---

## 🌐 自定义域名（可选）

### 为什么要自定义域名？
- ✅ 更短更美观
- ✅ 品牌化
- ✅ `.pages.dev` 在某些地区可能被限速

### 配置步骤

1. 在 Cloudflare Pages 项目中
2. 进入 **Custom domains**
3. 点击 **Set up a custom domain**
4. 输入域名：`gallery.yourdomain.com`
5. 按提示配置 DNS（如果域名在 Cloudflare，会自动配置）
6. 等待 SSL 证书生成（通常几分钟）
7. 完成后，更新 Bot 配置：
   ```python
   WORKER_GALLERY_API = "https://gallery.yourdomain.com"
   ```

---

## 📊 监控部署

### 查看部署日志

1. Cloudflare Pages 项目页面
2. **Deployments** 标签
3. 点击任意部署查看详细日志

### 查看实时日志

1. 项目页面 → **Functions**
2. **Logs** 标签（实时日志）
3. 可以看到每个请求的详细信息

### 查看分析数据

1. 项目页面 → **Analytics**
2. 可以看到：
   - 请求数
   - 错误率
   - 响应时间
   - 流量来源

---

## 🔐 环境变量（可选）

如果需要添加环境变量（如管理员 Token）：

1. 项目页面 → **Settings** → **Environment variables**
2. 点击 **Add variable**
3. 填写：
   - **Variable name:** `ADMIN_TOKEN`
   - **Value:** `your-secret-token`
   - **Environment:** Production
4. 点击 **Save**
5. 重新部署

在代码中使用：
```javascript
const ADMIN_TOKEN = env.ADMIN_TOKEN;
```

---

## ⚡ Pages vs Workers 区别

### Cloudflare Pages（当前方案）
- ✅ 免费额度更大
- ✅ 支持 Git 自动部署
- ✅ 内置 CI/CD
- ✅ 可以托管静态文件 + Functions
- ⚠️ Functions 功能与 Workers 相同

### Cloudflare Workers（命令行部署）
- ✅ 更直接
- ⚠️ 需要本地 Wrangler CLI
- ⚠️ 手动部署

**结论：Pages 更适合您的场景！**

---

## ❓ 常见问题

### Q1: Push 失败怎么办？

**A:** 检查认证：
```bash
# 使用 Token
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR-USERNAME/image-gallery-worker.git

# 或使用 SSH
git remote set-url origin git@github.com:YOUR-USERNAME/image-gallery-worker.git
```

### Q2: 部署后 500 错误？

**A:** 检查 KV 绑定：
1. Settings → Functions → KV namespace bindings
2. 确保 Variable name 是 `KV`
3. 重新部署

### Q3: 如何回滚到之前版本？

**A:** 
1. Deployments 页面
2. 找到想回滚的版本
3. 点击 **Rollback to this deployment**

### Q4: 修改代码后没有自动部署？

**A:** 检查：
1. GitHub Webhook 是否正常
2. Settings → Git → 查看 Webhook 状态
3. 手动触发：Deployments → Retry deployment

---

## ✅ 部署检查清单

- [ ] GitHub 仓库已创建
- [ ] 代码已 Push 到 GitHub
- [ ] Cloudflare Pages 已连接 GitHub
- [ ] 项目已成功部署
- [ ] KV 命名空间已绑定
- [ ] 测试 `/health` 端点正常
- [ ] Bot config.py 已配置 WORKER_GALLERY_API
- [ ] Bot 已重启
- [ ] 发送测试图集链接验证功能

---

## 🎉 完成！

通过 GitHub 部署的优势：
- ✅ 每次 Push 自动部署
- ✅ 有完整的版本历史
- ✅ 可以快速回滚
- ✅ 无需本地工具

**现在去完成部署吧！** 🚀

