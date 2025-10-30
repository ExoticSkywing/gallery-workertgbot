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

            // 2. 查看画廊页面
            if (path.startsWith('/gallery/')) {
                return await handleViewGallery(path, env);
            }

            // 3. Telegraph 图片代理（解决国内访问）
            if (path === '/img') {
                return await handleImageProxy(url, env);
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

        // 生成唯一 ID
        const id = generateGalleryId();

        // 构建画廊数据
        const galleryData = {
            id,
            title: data.title || '图集',
            author: data.author || '未知',
            images: data.images, // Telegraph 图床 URL 列表
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

// ========== Telegraph 图片代理 ==========
async function handleImageProxy(url, env) {
    const imgUrl = url.searchParams.get('url');

    if (!imgUrl) {
        return new Response('Missing url parameter', { status: 400 });
    }

    try {
        // 请求 Telegraph 图片
        const response = await fetch(imgUrl, {
            cf: {
                cacheEverything: true,
                cacheTtl: 86400 // 24小时缓存
            }
        });

        if (!response.ok) {
            return new Response('Image not found', { status: 404 });
        }

        // 返回图片
        return new Response(response.body, {
            headers: {
                'Content-Type': response.headers.get('Content-Type') || 'image/jpeg',
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (error) {
        console.error('Image proxy error:', error);
        return new Response('Proxy error', { status: 500 });
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

// 生成画廊 HTML
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        .header h1 {
            font-size: 28px;
            margin-bottom: 15px;
            color: #1a1a1a;
        }
        .meta {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            color: #666;
            font-size: 14px;
        }
        .meta-item {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .image-card {
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: pointer;
        }
        .image-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        }
        .image-card img {
            width: 100%;
            height: 280px;
            object-fit: cover;
            display: block;
        }
        .image-footer {
            padding: 12px;
            text-align: center;
            font-size: 13px;
            color: #666;
            background: #fafafa;
        }
        .download-btn {
            display: none;
            position: absolute;
            bottom: 12px;
            right: 12px;
            background: rgba(0,0,0,0.7);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            text-decoration: none;
            font-size: 13px;
            transition: background 0.2s;
        }
        .image-card:hover .download-btn {
            display: block;
        }
        .download-btn:hover {
            background: rgba(0,0,0,0.9);
        }
        .footer {
            text-align: center;
            padding: 30px;
            color: #999;
            font-size: 13px;
        }
        /* 灯箱 */
        .lightbox {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.95);
            z-index: 9999;
            justify-content: center;
            align-items: center;
        }
        .lightbox.active {
            display: flex;
        }
        .lightbox img {
            max-width: 90%;
            max-height: 90%;
            object-fit: contain;
        }
        .lightbox-close {
            position: absolute;
            top: 20px;
            right: 30px;
            color: white;
            font-size: 40px;
            cursor: pointer;
            user-select: none;
        }
        @media (max-width: 768px) {
            .gallery {
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 12px;
            }
            .image-card img {
                height: 180px;
            }
            .header h1 {
                font-size: 22px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📸 ${title}</h1>
            <div class="meta">
                <div class="meta-item">👤 ${author}</div>
                <div class="meta-item">📅 ${createdDate}</div>
                <div class="meta-item">🖼️ ${images.length} 张图片</div>
                <div class="meta-item">⏰ 30天有效</div>
            </div>
        </div>

        <div class="gallery">
            ${images.map((img, index) => `
                <div class="image-card" onclick="openLightbox(${index})">
                    <img src="${escapeHtml(img)}" alt="图片 ${index + 1}" loading="lazy">
                    <div class="image-footer">图片 ${index + 1}/${images.length}</div>
                    <a href="${escapeHtml(img)}" download="image-${index + 1}.jpg" class="download-btn" onclick="event.stopPropagation()">💾 下载</a>
                </div>
            `).join('')}
        </div>

        <div class="footer">
            <p>🌍 国内外均可访问 · ⚡ 由 Cloudflare Workers 强力驱动</p>
        </div>
    </div>

    <!-- 灯箱 -->
    <div class="lightbox" id="lightbox" onclick="closeLightbox()">
        <span class="lightbox-close">&times;</span>
        <img id="lightbox-img" src="" alt="">
    </div>

    <script>
        const images = ${JSON.stringify(images)};
        
        function openLightbox(index) {
            const lightbox = document.getElementById('lightbox');
            const img = document.getElementById('lightbox-img');
            img.src = images[index];
            lightbox.classList.add('active');
        }

        function closeLightbox() {
            document.getElementById('lightbox').classList.remove('active');
        }

        // ESC 键关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeLightbox();
        });
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

