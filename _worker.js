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

            // 4. 画廊广场（浏览所有画廊）
            if (path === '/explore' || path === '/plaza') {
                return await handleGalleryPlaza(env, url.searchParams);
            }

            // 5. 配额查询 API
            if (path === '/api/quota' && request.method === 'GET') {
                return await handleQuotaCheck(request, env);
            }

            // 6. 健康检查
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
            image_count: data.images.length,
            theme_colors: data.theme_colors || null // 主题色（可选）
        };
        
        // 日志记录主题色
        if (data.theme_colors) {
            console.log(`🎨 Gallery ${id} theme colors:`, data.theme_colors);
        }

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

// ========== 画廊广场 ==========
async function handleGalleryPlaza(env, searchParams) {
    try {
        // 从 KV 获取所有画廊（使用 list）
        const limit = parseInt(searchParams.get('limit')) || 50;
        const { keys } = await env.KV.list({ 
            prefix: 'gallery:', 
            limit: Math.min(limit, 100) // 最多100个
        });

        // 并行读取所有画廊数据
        const galleryPromises = keys.map(key => 
            env.KV.get(key.name, 'json')
        );
        const galleries = await Promise.all(galleryPromises);

        // 过滤掉空数据，按创建时间倒序排序
        const validGalleries = galleries
            .filter(g => g && g.id)
            .sort((a, b) => (b.created || 0) - (a.created || 0));

        // 生成广场页面
        const html = generatePlazaHTML(validGalleries);

        return new Response(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=300' // 缓存5分钟
            }
        });

    } catch (error) {
        console.error('Plaza error:', error);
        return new Response(
            generatePlazaErrorHTML(error.message),
            { 
                status: 500,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
        );
    }
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
        
        .swipe-hint {
            position: absolute;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.8);
            font-size: 13px;
            display: none;
            animation: fadeInOut 3s ease-in-out;
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
        
        @keyframes fadeInOut {
            0%, 100% { opacity: 0; }
            10%, 90% { opacity: 1; }
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
                width: 44px;
                height: 44px;
                font-size: 22px;
                background: rgba(255,255,255,0.3);
                /* 增强触摸目标大小 */
            }
            .lightbox-prev { left: 10px; }
            .lightbox-next { right: 10px; }
            .swipe-hint {
                display: block; /* 移动端显示滑动提示 */
            }
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
        <div class="swipe-hint">👆 左右滑动切换图片</div>
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
        
        // 触摸滑动手势支持（移动端）
        let touchStartX = 0;
        let touchEndX = 0;
        let touchStartY = 0;
        let touchEndY = 0;
        const minSwipeDistance = 50; // 最小滑动距离（像素）
        
        const lightboxImg = document.getElementById('lightbox-img');
        
        lightboxImg.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });
        
        lightboxImg.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            touchEndY = e.changedTouches[0].screenY;
            handleSwipe();
        }, { passive: true });
        
        function handleSwipe() {
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            
            // 判断是否为水平滑动（水平位移 > 垂直位移）
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
                if (deltaX > 0) {
                    // 向右滑动 = 上一张
                    navigateLightbox(-1);
                } else {
                    // 向左滑动 = 下一张
                    navigateLightbox(1);
                }
            }
        }
        
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

// 生成画廊广场页面
function generatePlazaHTML(galleries) {
    const totalCount = galleries.length;
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>画廊广场 - Gallery Plaza</title>
    <style>
        :root {
            --bg-primary: #fafafa;
            --bg-secondary: #ffffff;
            --text-primary: #1a1a1a;
            --text-secondary: #666;
            --text-tertiary: #999;
            --border-color: #e0e0e0;
            --shadow: 0 2px 12px rgba(0,0,0,0.08);
            --shadow-hover: 0 8px 24px rgba(0,0,0,0.12);
            --accent: #667eea;
            --radius: 16px;
        }
        
        [data-theme="dark"] {
            --bg-primary: #0a0a0a;
            --bg-secondary: #1a1a1a;
            --text-primary: #e8e8e8;
            --text-secondary: #aaa;
            --text-tertiary: #666;
            --border-color: #2d2d2d;
            --shadow: 0 2px 12px rgba(0,0,0,0.3);
            --shadow-hover: 0 8px 24px rgba(0,0,0,0.5);
            --accent: #8b9efc;
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
        
        /* 顶部导航栏 */
        .navbar {
            position: sticky;
            top: 0;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            padding: 16px 0;
            z-index: 100;
            backdrop-filter: blur(10px);
            box-shadow: var(--shadow);
        }
        
        .navbar-content {
            max-width: 1400px;
            margin: 0 auto;
            padding: 0 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .navbar-title {
            font-size: 24px;
            font-weight: 700;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .navbar-subtitle {
            font-size: 14px;
            color: var(--text-secondary);
            margin-left: 12px;
        }
        
        .navbar-actions {
            display: flex;
            gap: 12px;
        }
        
        .btn {
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            color: var(--text-primary);
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow);
        }
        
        /* 容器 */
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 30px 20px;
        }
        
        /* 统计信息 */
        .stats {
            text-align: center;
            margin-bottom: 40px;
            padding: 30px;
            background: var(--bg-secondary);
            border-radius: var(--radius);
            box-shadow: var(--shadow);
        }
        
        .stats-number {
            font-size: 48px;
            font-weight: 700;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }
        
        .stats-label {
            font-size: 16px;
            color: var(--text-secondary);
        }
        
        /* 瀑布流画廊 */
        .plaza-gallery {
            column-count: 4;
            column-gap: 20px;
        }
        
        .gallery-card {
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
        
        .gallery-card:hover {
            transform: translateY(-8px);
            box-shadow: var(--shadow-hover);
        }
        
        /* 🎨 主题色样式 */
        .gallery-card.has-theme {
            border: 2px solid transparent;
            background: linear-gradient(var(--bg-secondary), var(--bg-secondary)) padding-box,
                        linear-gradient(135deg, var(--theme-primary, #6366f1), var(--theme-accent, #8b5cf6)) border-box;
            position: relative;
        }
        
        .gallery-card.has-theme:hover {
            box-shadow: 0 20px 60px -15px var(--theme-primary), 
                        0 0 0 1px var(--theme-primary);
            transform: translateY(-10px);
        }
        
        .gallery-card.has-theme .gif-badge {
            background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent));
            border: none;
        }
        
        .gallery-card.has-theme .card-time {
            background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-weight: 600;
        }
        
        /* 封面拼图 */
        .card-cover {
            position: relative;
            width: 100%;
            overflow: hidden;
            background: var(--bg-primary);
        }
        
        .cover-grid {
            display: grid;
            gap: 2px;
        }
        
        .cover-grid-2 {
            grid-template-columns: 1fr 1fr;
        }
        
        /* 2图布局：左右对半 */
        .cover-grid-2 .cover-img {
            height: 200px;
        }
        
        .cover-grid-3 {
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 2fr 1fr;
        }
        
        .cover-grid-3 img:first-child {
            grid-column: 1 / 3;
        }
        
        .cover-grid-4 {
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
        }
        
        .cover-img {
            width: 100%;
            height: 180px;
            object-fit: cover;
            transition: transform 0.3s;
        }
        
        /* 单图：大图展示 */
        .card-cover img.cover-img:only-child {
            height: 300px;
            object-fit: cover;
        }
        
        /* 3图布局：1大2小 */
        .cover-grid-3 .cover-img:first-child {
            height: 240px;
        }
        
        .cover-grid-3 .cover-img:not(:first-child) {
            height: 120px;
        }
        
        /* 4图网格：标准高度 */
        .cover-grid-4 .cover-img {
            height: 150px;
        }
        
        /* 新增：大横图单图（Hero布局）*/
        .cover-hero .cover-img {
            height: 320px;
            object-fit: cover;
        }
        
        /* 新增：3竖图横排（Triple布局）*/
        .cover-grid-triple {
            grid-template-columns: 1fr 1fr 1fr;
        }
        
        .cover-grid-triple .cover-img {
            height: 260px;
            object-fit: cover;
        }
        
        .gallery-card:hover .cover-img {
            transform: scale(1.05);
        }
        
        /* GIF 标识 */
        .gif-badge {
            position: absolute;
            top: 12px;
            right: 12px;
            background: rgba(0,0,0,0.8);
            backdrop-filter: blur(10px);
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        /* 卡片信息 */
        .card-info {
            padding: 16px;
        }
        
        .card-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .card-meta {
            display: flex;
            gap: 12px;
            font-size: 13px;
            color: var(--text-secondary);
            flex-wrap: wrap;
        }
        
        .card-meta-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .card-time {
            font-size: 12px;
            color: var(--text-tertiary);
            margin-top: 6px;
        }
        
        /* 空状态 */
        .empty-state {
            text-align: center;
            padding: 80px 20px;
            color: var(--text-secondary);
        }
        
        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 20px;
            opacity: 0.5;
        }
        
        /* 响应式 */
        @media (max-width: 1200px) {
            .plaza-gallery { column-count: 3; }
        }
        
        @media (max-width: 768px) {
            .plaza-gallery { 
                column-count: 2; 
                column-gap: 12px;
            }
            .navbar-title {
                font-size: 20px;
            }
            .navbar-subtitle {
                display: none;
            }
            .stats-number {
                font-size: 36px;
            }
            .cover-img {
                height: 150px;
            }
            .cover-grid-3 .cover-img:first-child {
                height: 200px;
            }
            .cover-grid-3 .cover-img:not(:first-child) {
                height: 100px;
            }
            /* Hero布局移动端优化 */
            .cover-hero .cover-img {
                height: 240px;
            }
            /* Triple布局移动端优化 */
            .cover-grid-triple .cover-img {
                height: 200px;
            }
        }
        
        @media (max-width: 480px) {
            .container {
                padding: 20px 12px;
            }
        }
    </style>
</head>
<body>
    <!-- 导航栏 -->
    <nav class="navbar">
        <div class="navbar-content">
            <div style="display: flex; align-items: center;">
                <div class="navbar-title">🎨 画廊广场</div>
                <span class="navbar-subtitle">探索 ${totalCount} 个精彩画廊</span>
            </div>
            <div class="navbar-actions">
                <button class="btn" onclick="toggleTheme()">
                    <span id="theme-icon">🌙</span>
                    <span id="theme-text">深色</span>
                </button>
                <button class="btn" onclick="window.location.reload()">
                    🔄 刷新
                </button>
            </div>
        </div>
    </nav>

    <div class="container">
        <!-- 统计信息 -->
        <div class="stats">
            <div class="stats-number">${totalCount}</div>
            <div class="stats-label">精彩画廊等你探索</div>
        </div>

        <!-- 画廊网格 -->
        ${totalCount > 0 ? `
        <div class="plaza-gallery">
            ${galleries.map(gallery => generateGalleryCard(gallery)).join('')}
        </div>
        ` : `
        <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <h3>暂无画廊</h3>
            <p style="margin-top: 8px;">快去创建第一个画廊吧！</p>
        </div>
        `}
    </div>

    <script>
        // 深色模式
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            
            document.getElementById('theme-icon').textContent = newTheme === 'dark' ? '☀️' : '🌙';
            document.getElementById('theme-text').textContent = newTheme === 'dark' ? '浅色' : '深色';
            
            localStorage.setItem('theme', newTheme);
        }
        
        // 加载保存的主题
        (function() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            if (savedTheme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                document.getElementById('theme-icon').textContent = '☀️';
                document.getElementById('theme-text').textContent = '浅色';
            }
        })();
        
        // 点击卡片跳转
        function openGallery(id) {
            window.location.href = \`/gallery/\${id}\`;
        }
    </script>
</body>
</html>`;
}

// 生成单个画廊卡片
function generateGalleryCard(gallery) {
    const { id, title, author, images, created, image_count, theme_colors } = gallery;
    const count = image_count || images.length;
    const hasGif = images.some(img => 
        img.toLowerCase().includes('.gif') || 
        img.toLowerCase().includes('mmbiz_gif') ||
        img.toLowerCase().includes('wx_fmt=gif')
    );
    
    // 智能选择封面布局（根据总图片数 + ID哈希）
    const layoutType = getSmartLayout(count, id);
    const coverImages = images.slice(0, layoutType.imageCount);
    const coverHTML = generateCoverHTML(coverImages, layoutType.layout);
    
    // 格式化时间
    const timeAgo = formatTimeAgo(created);
    
    // 🎨 应用主题色（如果有）
    const cardStyle = theme_colors ? 
        `style="--theme-primary: ${theme_colors.primary}; --theme-accent: ${theme_colors.accent};"` : '';
    const hasTheme = theme_colors ? 'has-theme' : '';
    
    return `
    <div class="gallery-card ${hasTheme}" ${cardStyle} onclick="openGallery('${escapeHtml(id)}')">
        <div class="card-cover">
            ${coverHTML}
            ${hasGif ? '<div class="gif-badge">🎬 GIF</div>' : ''}
        </div>
        <div class="card-info">
            <div class="card-title">${escapeHtml(title || '图集')}</div>
            <div class="card-meta">
                <div class="card-meta-item">👤 ${escapeHtml(author || '未知')}</div>
                <div class="card-meta-item">📸 ${count} 张</div>
            </div>
            <div class="card-time">🕐 ${timeAgo}</div>
        </div>
    </div>`;
}

// 智能布局策略（渐进优化：5种布局）
function getSmartLayout(totalCount, galleryId) {
    // 特殊处理：1-2张图的画廊
    if (totalCount === 1) {
        return { layout: 'single', imageCount: 1 };
    } else if (totalCount === 2) {
        return { layout: 'split', imageCount: 2 };
    }
    
    // 3+张图：使用ID哈希来决定布局，增加视觉多样性
    // 渐进优化：从3种增加到5种布局
    const hash = simpleHash(galleryId);
    const layoutIndex = hash % 5; // 0, 1, 2, 3, 4
    
    switch(layoutIndex) {
        case 0:
            // 20% 概率：2图左右对半（简约大气）
            return { layout: 'split', imageCount: 2 };
        case 1:
            // 20% 概率：3图1大2小（艺术感）
            return { layout: 'featured', imageCount: 3 };
        case 2:
            // 20% 概率：4图网格（饱满丰富）
            return { layout: 'grid', imageCount: 4 };
        case 3:
            // 20% 概率：大横图单图（视觉冲击）
            return { layout: 'hero', imageCount: 1 };
        case 4:
            // 20% 概率：3竖图横排（精致优雅）
            return { layout: 'triple', imageCount: 3 };
        default:
            return { layout: 'grid', imageCount: 4 };
    }
}

// 简单哈希函数（将字符串转为数字）
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

// 获取封面布局（废弃，保留兼容）
function getCoverLayout(count) {
    if (count === 1) return 'single';
    if (count === 2) return 'split';
    if (count === 3) return 'featured';
    return 'grid';
}

// 生成封面HTML
function generateCoverHTML(images, layout) {
    // Hero布局：大横图单图
    if (layout === 'hero') {
        return `<div class="cover-hero"><img src="${escapeHtml(images[0])}" alt="" class="cover-img" loading="lazy"></div>`;
    }
    
    // Single布局：单图（原有）
    if (layout === 'single') {
        return `<img src="${escapeHtml(images[0])}" alt="" class="cover-img" loading="lazy">`;
    }
    
    // 其他网格布局
    const gridClass = layout === 'split' ? 'cover-grid-2' : 
                      layout === 'featured' ? 'cover-grid-3' : 
                      layout === 'triple' ? 'cover-grid-triple' :
                      'cover-grid-4';
    
    return `
    <div class="cover-grid ${gridClass}">
        ${images.map(img => 
            `<img src="${escapeHtml(img)}" alt="" class="cover-img" loading="lazy">`
        ).join('')}
    </div>`;
}

// 格式化时间
function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 30) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
}

// 广场错误页面
function generatePlazaErrorHTML(errorMsg) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>加载失败 - 画廊广场</title>
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
    </style>
</head>
<body>
    <div class="error-box">
        <h1>😔</h1>
        <h3>加载失败</h3>
        <p style="color: #666; margin-top: 12px;">${escapeHtml(errorMsg)}</p>
        <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 20px; border-radius: 8px; border: none; background: #667eea; color: white; cursor: pointer;">
            重试
        </button>
    </div>
</body>
</html>`;
}

