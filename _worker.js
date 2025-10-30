// Image Gallery Worker
// 为 mirrorbot 提供图集画廊服务，解决 Telegraph 国内访问问题

const GALLERY_TTL = 30 * 24 * 60 * 60; // 30天（秒）
const QUOTA_WARN_THRESHOLD = 0.98; // 98%预警

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS 处理
        if (request.method === 'OPTIONS') {
            return handleCORS();
        }

        try {
            // 1. 创建画廊 API
            if (path === '/api/create-gallery' && request.method === 'POST') {
                return await handleCreateGallery(request, env);
            }

            // 2. 检查画廊是否存在 API
            if (path.startsWith('/api/check/') && request.method === 'GET') {
                const galleryId = path.split('/').pop();
                return await handleCheckGallery(galleryId, env, url.origin);
            }

            // 3. 查看画廊页面
            if (path.startsWith('/gallery/')) {
                return await handleViewGallery(path, env);
            }

            // 4. 配额查询 API
            if (path === '/api/quota' && request.method === 'GET') {
                return await handleQuotaCheck(request, env);
            }

            // 5. 健康检查
            if (path === '/health') {
                return Response.json({
                    status: 'ok',
                    service: 'Image Gallery Worker',
                    timestamp: new Date().toISOString()
                });
            }

            // 404
            return new Response('Not Found', { status: 404 });

        } catch (error) {
            console.error('Worker error:', error);
            return Response.json({
                error: error.message
            }, { status: 500 });
        }
    }
};

// ========== 检查画廊是否存在 ==========
async function handleCheckGallery(galleryId, env, origin) {
    try {
        const key = `gallery:${galleryId}`;
        const data = await env.KV.get(key);
        
        if (data) {
            const galleryData = JSON.parse(data);
            return Response.json({
                exists: true,
                gallery_url: `${origin}/gallery/${galleryId}`,
                image_count: galleryData.image_count || galleryData.images.length,
                created: galleryData.created
            });
        }
        
        return Response.json({
            exists: false
        });
    } catch (error) {
        console.error('Check gallery error:', error);
        return Response.json({
            exists: false,
            error: error.message
        }, { status: 500 });
    }
}

// ========== 创建画廊 ==========
async function handleCreateGallery(request, env) {
    try {
        const data = await request.json();

        // 验证必需字段
        if (!data.images || !Array.isArray(data.images) || data.images.length === 0) {
            return Response.json({
                success: false,
                error: 'INVALID_DATA',
                message: '图片列表不能为空'
            }, { status: 400 });
        }

        // 获取或生成画廊ID（支持客户端指定ID）
        const id = data.gallery_id || generateGalleryId();
        
        // 检查画廊是否已存在
        const existingData = await env.KV.get(`gallery:${id}`);
        if (existingData) {
            // 画廊已存在，直接返回
            const url = new URL(request.url);
            return Response.json({
                success: true,
                gallery_id: id,
                gallery_url: `${url.origin}/gallery/${id}`,
                message: 'ALREADY_EXISTS',
                note: '画廊已存在，无需重复创建'
            });
        }

        // 构建画廊数据
        const galleryData = {
            id,
            title: data.title || '图集',
            author: data.author || '未知',
            images: data.images, // Catbox 图床 URL 列表
            created: Date.now(),
            image_count: data.images.length
        };

        // 存储到 KV（30天自动过期）
        try {
            await env.KV.put(
                `gallery:${id}`,
                JSON.stringify(galleryData),
                { expirationTtl: GALLERY_TTL }
            );
        } catch (kvError) {
            // KV 写入失败（可能是配额用完）
            console.error('KV put error:', kvError);
            
            // 检查是否是配额问题
            if (kvError.message && kvError.message.includes('quota')) {
                return Response.json({
                    success: false,
                    error: 'QUOTA_EXCEEDED',
                    message: '今日画廊创建已达上限，请明天再试'
                }, { status: 429 });
            }
            
            throw kvError;
        }

        // 增加今日计数（用于配额监控）
        await incrementDailyQuota(env);

        // 构建画廊URL
        const galleryUrl = `${new URL(request.url).origin}/gallery/${id}`;

        return Response.json({
            success: true,
            gallery_url: galleryUrl,
            id,
            expires_in_days: 30
        }, {
            headers: {
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (error) {
        console.error('Create gallery error:', error);
        return Response.json({
            success: false,
            error: 'SERVER_ERROR',
            message: error.message
        }, { status: 500 });
    }
}

// ========== 查看画廊页面 ==========
async function handleViewGallery(path, env) {
    const id = path.split('/')[2];

    if (!id) {
        return new Response('Invalid gallery ID', { status: 400 });
    }

    // 从 KV 读取画廊数据
    const galleryData = await env.KV.get(`gallery:${id}`, 'json');

    if (!galleryData) {
        return new Response(
            generateNotFoundHTML(),
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    }

    // 生成画廊 HTML
    const html = generateGalleryHTML(galleryData);

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
        }
    });
}

// ========== 配额查询 ==========
async function handleQuotaCheck(request, env) {
    const auth = request.headers.get('Authorization');
    const expectedAuth = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : null;

    // 简单认证（可选）
    if (expectedAuth && auth !== expectedAuth) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const todayKey = `quota:${getDateKey()}`;
    const todayCount = parseInt(await env.KV.get(todayKey) || '0');

    const quota = {
        date: getDateKey(),
        used: todayCount,
        limit: 1000,
        remaining: Math.max(0, 1000 - todayCount),
        percentage: ((todayCount / 1000) * 100).toFixed(1),
        warning: todayCount >= 980 // 98%
    };

    return Response.json(quota, {
        headers: { 'Access-Control-Allow-Origin': '*' }
    });
}

// ========== 辅助函数 ==========

// 生成画廊 ID
function generateGalleryId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 5);
    return `${timestamp}${random}`;
}

// 获取日期键（UTC）
function getDateKey() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 增加今日配额计数
async function incrementDailyQuota(env) {
    const todayKey = `quota:${getDateKey()}`;
    const current = parseInt(await env.KV.get(todayKey) || '0');
    await env.KV.put(todayKey, String(current + 1), {
        expirationTtl: 86400 // 24小时过期
    });
}

// CORS 处理
function handleCORS() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
    });
}

// 生成画廊 HTML（精美升级版）
function generateGalleryHTML(data) {
    const images = data.images || [];
    const title = escapeHtml(data.title || '图集');
    const author = escapeHtml(data.author || '未知');
    const createdDate = new Date(data.created).toLocaleDateString('zh-CN');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - 图集画廊</title>
    <style>
        :root {
            --bg-primary: #f8f9fa;
            --bg-secondary: #ffffff;
            --text-primary: #1a1a1a;
            --text-secondary: #666;
            --border-color: #e0e0e0;
            --shadow: 0 2px 12px rgba(0,0,0,0.08);
            --shadow-hover: 0 8px 24px rgba(0,0,0,0.12);
            --accent: #007bff;
            --radius: 16px;
        }
        
        [data-theme="dark"] {
            --bg-primary: #1a1a1a;
            --bg-secondary: #2d2d2d;
            --text-primary: #e8e8e8;
            --text-secondary: #aaa;
            --border-color: #404040;
            --shadow: 0 2px 12px rgba(0,0,0,0.3);
            --shadow-hover: 0 8px 24px rgba(0,0,0,0.5);
        }
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            transition: background 0.3s ease, color 0.3s ease;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        
        /* 顶部栏 */
        .top-bar {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .btn {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            padding: 10px 20px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 14px;
            color: var(--text-primary);
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: var(--shadow);
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-hover);
        }
        
        /* 头部 */
        .header {
            background: var(--bg-secondary);
            padding: 40px;
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            margin-bottom: 30px;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
        }
        
        .header h1 {
            font-size: 32px;
            margin-bottom: 20px;
            color: var(--text-primary);
            font-weight: 700;
        }
        
        .meta {
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
            color: var(--text-secondary);
            font-size: 14px;
        }
        
        .meta-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--bg-primary);
            border-radius: 8px;
        }
        
        /* 瀑布流画廊 */
        .gallery {
            column-count: 4;
            column-gap: 20px;
            margin-bottom: 40px;
        }
        
        .image-card {
            background: var(--bg-secondary);
            border-radius: var(--radius);
            overflow: hidden;
            box-shadow: var(--shadow);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            cursor: pointer;
            break-inside: avoid;
            margin-bottom: 20px;
            position: relative;
        }
        
        .image-card:hover {
            transform: translateY(-6px) scale(1.02);
            box-shadow: var(--shadow-hover);
        }
        
        .image-card img {
            width: 100%;
            display: block;
            transition: transform 0.3s;
        }
        
        .image-card:hover img {
            transform: scale(1.05);
        }
        
        .image-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
            padding: 20px 15px 15px;
            transform: translateY(100%);
            transition: transform 0.3s;
            color: white;
        }
        
        .image-card:hover .image-overlay {
            transform: translateY(0);
        }
        
        .image-number {
            font-size: 13px;
            font-weight: 500;
        }
        
        .download-btn {
            position: absolute;
            top: 12px;
            right: 12px;
            background: rgba(255,255,255,0.95);
            backdrop-filter: blur(10px);
            color: #333;
            padding: 8px 14px;
            border-radius: 8px;
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            opacity: 0;
            transition: all 0.3s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        
        .image-card:hover .download-btn {
            opacity: 1;
        }
        
        .download-btn:hover {
            background: white;
            transform: scale(1.05);
        }
        
        /* 灯箱（升级版） */
        .lightbox {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.97);
            z-index: 9999;
            justify-content: center;
            align-items: center;
            animation: fadeIn 0.3s;
        }
        
        .lightbox.active {
            display: flex;
        }
        
        .lightbox-content {
            position: relative;
            max-width: 95%;
            max-height: 95%;
        }
        
        .lightbox img {
            max-width: 100%;
            max-height: 90vh;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        
        .lightbox-controls {
            position: absolute;
            top: 20px;
            right: 20px;
            display: flex;
            gap: 12px;
        }
        
        .lightbox-btn {
            background: rgba(255,255,255,0.2);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 20px;
            transition: all 0.2s;
        }
        
        .lightbox-btn:hover {
            background: rgba(255,255,255,0.3);
            transform: scale(1.1);
        }
        
        .lightbox-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(255,255,255,0.2);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            width: 50px;
            height: 50px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 24px;
            transition: all 0.2s;
        }
        
        .lightbox-nav:hover {
            background: rgba(255,255,255,0.3);
        }
        
        .lightbox-prev { left: 30px; }
        .lightbox-next { right: 30px; }
        
        .lightbox-counter {
            position: absolute;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.6);
            backdrop-filter: blur(10px);
            color: white;
            padding: 8px 20px;
            border-radius: 20px;
            font-size: 14px;
        }
        
        /* 页脚 */
        .footer {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-secondary);
            font-size: 14px;
        }
        
        .footer a {
            color: var(--accent);
            text-decoration: none;
            font-weight: 500;
            transition: opacity 0.2s;
        }
        
        .footer a:hover {
            opacity: 0.8;
        }
        
        /* 加载动画 */
        .loading {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10000;
        }
        
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid var(--border-color);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        /* 响应式 */
        @media (max-width: 1200px) {
            .gallery { column-count: 3; }
        }
        
        @media (max-width: 768px) {
            .gallery { 
                column-count: 2; 
                column-gap: 12px;
            }
            .header {
                padding: 24px;
            }
            .header h1 {
                font-size: 24px;
            }
            .meta {
                gap: 12px;
            }
            .lightbox-nav {
                width: 40px;
                height: 40px;
                font-size: 20px;
            }
            .lightbox-prev { left: 15px; }
            .lightbox-next { right: 15px; }
        }
        
        @media (max-width: 480px) {
            .top-bar {
                flex-direction: column;
            }
            .container {
                padding: 12px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- 顶部控制栏 -->
        <div class="top-bar">
            <button class="btn" onclick="toggleTheme()">
                <span id="theme-icon">🌙</span> 
                <span id="theme-text">深色</span>
            </button>
            <button class="btn" onclick="shareGallery()">
                🔗 分享
            </button>
        </div>

        <!-- 头部信息 -->
        <div class="header">
            <h1>📸 ${title}</h1>
            <div class="meta">
                <div class="meta-item">👤 ${author}</div>
                <div class="meta-item">📅 ${createdDate}</div>
                <div class="meta-item">🖼️ ${images.length} 张图片</div>
                <div class="meta-item">⏰ 30天有效</div>
            </div>
        </div>

        <!-- 瀑布流画廊 -->
        <div class="gallery" id="gallery">
            ${images.map((img, index) => `
                <div class="image-card" onclick="openLightbox(${index})">
                    <img src="${escapeHtml(img)}" alt="图片 ${index + 1}" loading="lazy">
                    <div class="image-overlay">
                        <div class="image-number">图片 ${index + 1}/${images.length}</div>
                    </div>
                    <a href="${escapeHtml(img)}" download="image-${index + 1}" class="download-btn" onclick="event.stopPropagation()">💾 下载</a>
                </div>
            `).join('')}
        </div>

        <!-- 页脚 -->
        <div class="footer">
            <p>🌍 全球可访问 · ⚡ 由 <a href="https://1yo.cc" target="_blank">Nebuluxe</a> 强力驱动</p>
            <p style="margin-top: 12px; font-size: 12px; opacity: 0.7;">
                支持 GIF 动图 · 深色模式 · 快捷键导航
            </p>
        </div>
    </div>

    <!-- 灯箱 -->
    <div class="lightbox" id="lightbox">
        <div class="lightbox-controls">
            <div class="lightbox-btn" onclick="downloadCurrent()" title="下载当前图片">💾</div>
            <div class="lightbox-btn" onclick="closeLightbox()" title="关闭">✕</div>
        </div>
        <div class="lightbox-nav lightbox-prev" onclick="navigateLightbox(-1)">‹</div>
        <div class="lightbox-nav lightbox-next" onclick="navigateLightbox(1)">›</div>
        <div class="lightbox-content">
            <img id="lightbox-img" src="" alt="">
        </div>
        <div class="lightbox-counter" id="lightbox-counter">1 / ${images.length}</div>
    </div>

    <script>
        const images = ${JSON.stringify(images)};
        let currentIndex = 0;
        
        // 深色模式切换
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            
            // 更新按钮文字
            document.getElementById('theme-icon').textContent = newTheme === 'dark' ? '☀️' : '🌙';
            document.getElementById('theme-text').textContent = newTheme === 'dark' ? '浅色' : '深色';
            
            // 保存偏好
            localStorage.setItem('theme', newTheme);
        }
        
        // 加载保存的主题偏好
        (function() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            if (savedTheme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                document.getElementById('theme-icon').textContent = '☀️';
                document.getElementById('theme-text').textContent = '浅色';
            }
        })();
        
        // 分享功能
        async function shareGallery() {
            const url = window.location.href;
            const text = '${title} - ${images.length}张图片';
            
            if (navigator.share) {
                try {
                    await navigator.share({ title: text, url });
                } catch (e) {
                    copyToClipboard(url);
                }
            } else {
                copyToClipboard(url);
            }
        }
        
        function copyToClipboard(text) {
            const input = document.createElement('input');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            alert('链接已复制到剪贴板！');
        }
        
        // 灯箱功能（增强版）
        function openLightbox(index) {
            currentIndex = index;
            updateLightbox();
            document.getElementById('lightbox').classList.add('active');
            document.body.style.overflow = 'hidden';
        }
        
        function closeLightbox() {
            document.getElementById('lightbox').classList.remove('active');
            document.body.style.overflow = '';
        }
        
        function navigateLightbox(direction) {
            currentIndex = (currentIndex + direction + images.length) % images.length;
            updateLightbox();
        }
        
        function updateLightbox() {
            document.getElementById('lightbox-img').src = images[currentIndex];
            document.getElementById('lightbox-counter').textContent = 
                \`\${currentIndex + 1} / \${images.length}\`;
        }
        
        function downloadCurrent() {
            const link = document.createElement('a');
            link.href = images[currentIndex];
            link.download = \`image-\${currentIndex + 1}\`;
            link.click();
        }
        
        // 点击背景关闭灯箱
        document.getElementById('lightbox').addEventListener('click', function(e) {
            if (e.target === this) {
                closeLightbox();
            }
        });
        
        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            const lightbox = document.getElementById('lightbox');
            if (!lightbox.classList.contains('active')) return;
            
            switch(e.key) {
                case 'Escape':
                    closeLightbox();
                    break;
                case 'ArrowLeft':
                    navigateLightbox(-1);
                    break;
                case 'ArrowRight':
                    navigateLightbox(1);
                    break;
            }
        });
        
        // 批量下载功能（隐藏，保留接口）
        async function downloadAllImages() {
            // 预留批量下载功能
            // 未来可以通过ZIP打包或逐个下载
            console.log('Batch download feature reserved for future use');
        }
    </script>
</body>
</html>`;
}

// 404 页面
function generateNotFoundHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>画廊不存在</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: #f5f5f5;
        }
        .error-box {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .error-box h1 {
            font-size: 48px;
            margin-bottom: 20px;
        }
        .error-box p {
            color: #666;
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>404</h1>
        <p>😔 画廊不存在或已过期</p>
        <p style="margin-top: 20px; font-size: 14px;">画廊有效期为 30 天</p>
    </div>
</body>
</html>`;
}

// HTML 转义
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

