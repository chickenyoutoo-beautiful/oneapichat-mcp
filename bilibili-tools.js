// OneAPIChat — Bilibili MCP Tools
// 纯 Node.js 实现, 调用 B站公开 REST API
// 覆盖: 视频详情 / 专栏文章 / 用户动态 / 评论 / 搜索 / 用户主页
// 独立模块, 可直接迁移到其他 MCP server

const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');

const PY_BRIDGE = '/home/naujtrats/mcp-server/bilibili-bridge.py';
const PYTHON_BIN = '/usr/bin/python3';

// ── 通用 B站 API 请求头 ──
const BILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// ── Wbi 签名缓存 ──
let _wbiCache = null; // { img_key, sub_key, expires: timestamp }

/**
 * 从 B站 nav 接口获取 Wbi 签名密钥
 */
function getWbiKeys() {
    return new Promise((resolve, reject) => {
        // 缓存 30 分钟
        if (_wbiCache && Date.now() < _wbiCache.expires) {
            resolve({ img_key: _wbiCache.img_key, sub_key: _wbiCache.sub_key });
            return;
        }

        const opts = {
            hostname: 'api.bilibili.com',
            path: '/x/web-interface/nav',
            headers: { ...BILI_HEADERS },
            timeout: 8000,
        };

        https.get(opts, (resp) => {
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    const wbi = data?.data?.wbi_img;
                    if (!wbi) { resolve(null); return; }

                    // img_url: https://i0.hdslb.com/bfs/wbi/xxx.png
                    // sub_url: https://i0.hdslb.com/bfs/wbi/yyy.png
                    const imgKey = (wbi.img_url || '').split('/').pop().split('.')[0];
                    const subKey = (wbi.sub_url || '').split('/').pop().split('.')[0];

                    _wbiCache = {
                        img_key: imgKey,
                        sub_key: subKey,
                        expires: Date.now() + 30 * 60 * 1000,
                    };
                    resolve({ img_key: imgKey, sub_key: subKey });
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null)).on('timeout', () => { resolve(null); });
    });
}

/**
 * 生成 Wbi 签名的 mixin key
 * @param {string} imgKey
 * @param {string} subKey
 * @returns {string} 32-char mixin key
 */
function getMixinKey(imgKey, subKey) {
    const ord = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
    const s = imgKey + subKey;
    let mixin = '';
    for (const i of ord) {
        if (i < s.length) mixin += s[i];
    }
    return mixin.substring(0, 32);
}

/**
 * 对参数做 Wbi 签名
 * @param {object} params
 * @returns {Promise<object>} 添加了 w_rid 和 wts 的参数
 */
async function signParams(params) {
    const keys = await getWbiKeys();
    if (!keys) return params; // 签名失败则返回原参数

    const mixinKey = getMixinKey(keys.img_key, keys.sub_key);
    params.wts = Math.floor(Date.now() / 1000);

    // 排序 + 拼接
    const sorted = Object.keys(params).sort();
    const queryStr = sorted.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const w_rid = crypto.createHash('md5').update(queryStr + mixinKey).digest('hex');

    params.w_rid = w_rid;
    return params;
}

// ── 通用 B站 API GET 请求 ──
function biliGet(path, queryParams = {}) {
    return new Promise(async (resolve, reject) => {
        let params = { ...queryParams };
        // 尝试 Wbi 签名
        params = await signParams(params);

        const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
        const fullPath = path + (qs ? '?' + qs : '');

        const opts = {
            hostname: 'api.bilibili.com',
            path: fullPath,
            headers: { ...BILI_HEADERS },
            timeout: 15000,
        };

        const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 15000);

        const req = https.get(opts, (resp) => {
            clearTimeout(timer);
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    if (data.code !== 0) {
                        reject(new Error(`B站API错误 (code=${data.code}): ${data.message || '未知'}`));
                    } else {
                        resolve(data.data || data.result || {});
                    }
                } catch (e) {
                    reject(new Error('API响应解析失败'));
                }
            });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(new Error('网络错误: ' + e.message)); });
    });
}

// ═══════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════

const BILIBILI_TOOLS = [
    {
        name: 'bilibili_video_info',
        description: '获取B站视频详情: 标题、UP主、播放量、弹幕数、简介、封面、分P列表。支持 BV/AV号 和 b23.tv 短链接。用户分享B站链接时调用。',
        inputSchema: {
            type: 'object',
            properties: {
                bvid: { type: 'string', description: '视频BV号(如 BV1xx411c7mD)或AV号或b23.tv短链接' },
            },
            required: ['bvid'],
        },
    },
    {
        name: 'bilibili_article_read',
        description: '阅读B站专栏文章全文。传入专栏cv号或完整URL获取文章标题、作者、正文内容。',
        inputSchema: {
            type: 'object',
            properties: {
                cvid: { type: 'string', description: '专栏cv号(如 cv12345)或文章URL' },
            },
            required: ['cvid'],
        },
    },
    {
        name: 'bilibili_dynamic_list',
        description: '获取B站用户的最近动态列表(含图文动态、转发、视频投稿)。传入用户UID获取TA最近的动态内容。',
        inputSchema: {
            type: 'object',
            properties: {
                uid: { type: 'string', description: '用户UID' },
                limit: { type: 'integer', description: '获取条数, 默认10' },
            },
            required: ['uid'],
        },
    },
    {
        name: 'bilibili_comment_list',
        description: '获取B站视频/专栏/动态的评论。可获取热门评论或最新评论。',
        inputSchema: {
            type: 'object',
            properties: {
                oid: { type: 'string', description: '目标ID(视频BV号/专栏cv号)' },
                type: { type: 'integer', description: '评论区类型: 1=视频, 12=专栏, 17=动态, 默认1' },
                limit: { type: 'integer', description: '获取条数, 默认20' },
            },
            required: ['oid'],
        },
    },
    {
        name: 'bilibili_search',
        description: '综合搜索B站内容: 视频、专栏、用户。返回标题、作者、播放量、链接等信息。',
        inputSchema: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '搜索关键词' },
                search_type: { type: 'string', description: '搜索类型: video(视频)/article(专栏)/bili_user(用户), 默认video' },
                limit: { type: 'integer', description: '返回条数, 默认10' },
            },
            required: ['keyword'],
        },
    },
    {
        name: 'bilibili_qr_login',
        description: 'B站扫码登录。当B站Cookie失效需要重新登录时调用。生成二维码供用户扫描，自动轮询登录状态，成功后保存SESSDATA。',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'check=检查cookie有效性 / qr=生成二维码 / poll=检测扫码状态 / auto=一键自动登录', enum: ['check', 'qr', 'poll', 'auto'] },
                qrcode_key: { type: 'string', description: '轮询时传入(poll模式), 由qr步骤返回' },
                timeout: { type: 'integer', description: '自动登录超时秒数(auto模式), 默认120' },
            },
            required: ['action'],
        },
    },
    {
        name: 'bilibili_user_profile',
        description: '获取B站用户主页信息: 昵称、简介、粉丝数、关注数、投稿数、头像。',
        inputSchema: {
            type: 'object',
            properties: {
                uid: { type: 'string', description: '用户UID' },
            },
            required: ['uid'],
        },
    },
];

// ═══════════════════════════════════════════════════
// 工具执行
// ═══════════════════════════════════════════════════

/**
 * 从输入中提取 BV 号
 * 支持: 纯BV号、完整URL、b23.tv短链接
 */
function extractBvid(input) {
    // b23.tv 短链接 → 先不处理, 直接当 bvid 尝试
    // BV号
    const bvMatch = input.match(/BV[a-zA-Z0-9]{10}/);
    if (bvMatch) return bvMatch[0];
    // AV号
    const avMatch = input.match(/av(\d+)/i);
    if (avMatch) return 'av' + avMatch[1];
    // 纯数字 = AV号
    if (/^\d+$/.test(input)) return 'av' + input;
    return input;
}

/**
 * 从输入中提取专栏 cv 号
 */
function extractCvid(input) {
    const cvMatch = input.match(/cv(\d+)/i);
    if (cvMatch) return cvMatch[1];
    if (/^\d+$/.test(input)) return input;
    return input;
}

/**
 * 从输入中提取用户 UID
 */
function extractUid(input) {
    const uidMatch = input.match(/uid[=:](\d+)/i) || input.match(/space\.bilibili\.com\/(\d+)/);
    if (uidMatch) return uidMatch[1];
    return input;
}

async function execBilibiliTool(name, args) {
    switch (name) {
        // ★ QR 登录 (独立 Python 脚本)
        case 'bilibili_qr_login':
            return execQrLogin(args);
        // ★ Node.js 快速路径 (无需签名, 已验证)
        case 'bilibili_video_info':
            return execVideoInfo(args);
        // ★ Python 桥接 (需要 Wbi 签名 + 反爬)
        case 'bilibili_article_read':
            return execPythonBridge('article_read', [args.cvid || '']);
        case 'bilibili_search':
            return execPythonBridge('search', [args.keyword || '', args.search_type || 'video', args.limit || 10]);
        case 'bilibili_user_profile':
            return execPythonBridge('user_profile', [args.uid || '']);
        case 'bilibili_dynamic_list':
            return execPythonBridge('dynamic_list', [args.uid || '', args.limit || 10]);
        case 'bilibili_comment_list':
            return execPythonBridge('comment_list', [args.oid || '', args.type || 1, args.limit || 20]);
        default:
            throw new Error('未知B站工具: ' + name);
    }
}

// ── QR 码登录调用 ──
const LOGIN_SCRIPT = '/home/naujtrats/mcp-server/bilibili-login.py';

function execQrLogin(args) {
    return new Promise((resolve, reject) => {
        const action = args.action || 'qr';  // 默认先生成二维码立即显示, 之后用 poll 扫码
        const extraArgs = action === 'poll' ? [args.qrcode_key || ''] : (action === 'auto' ? [args.timeout || 120] : []);
        const argStr = extraArgs.map(a => JSON.stringify(String(a))).join(' ');
        const cmdStr = `${PYTHON_BIN} ${LOGIN_SCRIPT} ${action} ${argStr}`;

        exec(cmdStr, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && !stdout.trim()) { reject(new Error('Login error: ' + err.message)); return; }
            try {
                const result = JSON.parse(stdout.trim());
                resolve(result);
            } catch (e) {
                resolve({ ok: false, error: 'Parse error', raw: (stdout + stderr).trim().substring(0, 300) });
            }
        });
    });
}

// ── Python 桥接调用 ──
function execPythonBridge(cmd, args) {
    return new Promise((resolve, reject) => {
        const argsStr = args.map(a => JSON.stringify(String(a))).join(' ');
        const cmdStr = `${PYTHON_BIN} ${PY_BRIDGE} ${cmd} ${argsStr}`;
        exec(cmdStr, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && !stdout.trim()) {
                reject(new Error(`Python bridge error: ${err.message}`));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            } catch (e) {
                reject(new Error('Bridge parse error: ' + (stdout + stderr).trim().substring(0, 200)));
            }
        });
    });
}

// ── 1. 视频详情 ──
async function execVideoInfo(args) {
    const bvid = extractBvid(args.bvid || '');

    // 先获取基础信息
    const info = await biliGet('/x/web-interface/view', { bvid });
    // 再获取分P列表
    let pages = [];
    try {
        const pageData = await biliGet('/x/player/pagelist', { bvid });
        pages = (pageData || []).map(p => ({
            page: p.page,
            part: p.part || '',
            duration: formatDuration(p.duration || 0),
        }));
    } catch (e) { /* 单P视频无pagelist */ }

    // 尝试获取更详细的信息
    let detail = {};
    try {
        const d = await biliGet('/x/web-interface/view/detail', { bvid });
        detail.related = (d.Related || []).slice(0, 5).map(r => ({
            bvid: r.bvid, title: r.title, author: r.owner?.name, views: formatCount(r.stat?.view),
        }));
    } catch (e) { /* detail 接口可能返回空 */ }

    return {
        type: 'video',
        bvid: info.bvid,
        avid: info.aid,
        title: info.title || '',
        cover: info.pic || '',
        description: (info.desc || '').substring(0, 500),
        author: {
            name: info.owner?.name || '',
            uid: info.owner?.mid || 0,
            avatar: info.owner?.face || '',
        },
        stats: {
            views: formatCount(info.stat?.view),
            danmaku: formatCount(info.stat?.danmaku),
            likes: formatCount(info.stat?.like),
            coins: formatCount(info.stat?.coin),
            favorites: formatCount(info.stat?.favorite),
            shares: formatCount(info.stat?.share),
            comments: formatCount(info.stat?.reply),
        },
        duration: formatDuration(info.duration || 0),
        pubdate: info.pubdate ? new Date(info.pubdate * 1000).toISOString().split('T')[0] : '',
        pages: pages.length > 0 ? pages : [{ page: 1, part: info.title, duration: formatDuration(info.duration || 0) }],
        pages_count: pages.length || 1,
        url: `https://www.bilibili.com/video/${info.bvid}`,
        tags: (info.tgs || []).map(t => t.tag_name).filter(Boolean),
        related_videos: detail.related || [],
    };
}

// ── 2. 专栏文章 ──
async function execArticleRead(args) {
    let cvid = extractCvid(args.cvid || '');

    // 如果传入的是完整URL, 先尝试通过 search 接口找到 cv 号
    if (!cvid || cvid === args.cvid) {
        const urlMatch = (args.cvid || '').match(/cv(\d+)/i);
        if (urlMatch) cvid = urlMatch[1];
    }

    const article = await biliGet('/x/article/view', { id: parseInt(cvid) });

    return {
        type: 'article',
        id: article.id,
        title: article.title || '',
        author: {
            name: article.author_name || '',
            uid: article.author?.mid || article.mid || 0,
            avatar: article.author?.face || '',
        },
        summary: article.summary || '',
        content: parseArticleContent(article.content || ''),
        stats: {
            views: formatCount(article.stats?.view),
            likes: formatCount(article.stats?.like),
            comments: formatCount(article.stats?.reply),
            favorites: formatCount(article.stats?.favorite),
            coins: formatCount(article.stats?.coin),
        },
        publish_time: article.publish_time ? new Date(article.publish_time * 1000).toISOString() : '',
        url: `https://www.bilibili.com/read/cv${article.id}`,
        image_urls: article.image_urls || [],
        tags: (article.tags || []).map(t => t.tag_name || t).filter(Boolean),
    };
}

// ── 3. 用户动态 ──
async function execDynamicList(args) {
    const uid = extractUid(args.uid || '');
    const limit = Math.min(args.limit || 10, 30);

    const feed = await biliGet('/x/polymer/web-dynamic/v1/feed/space', {
        host_mid: uid,
        offset: '',
    });

    const items = (feed.items || []).slice(0, limit).map(item => {
        const mod = item.modules || {};
        const desc = mod.module_dynamic?.desc;
        const major = mod.module_dynamic?.major;
        const author = mod.module_author;
        const stat = mod.module_stat;

        let contentType = 'unknown';
        let content = '';
        let mediaUrls = [];

        // 解析不同类型的动态
        if (major?.archive) {
            contentType = 'video';
            content = `[视频] ${major.archive.title || ''}`;
            mediaUrls = [major.archive.cover || ''];
        } else if (major?.article) {
            contentType = 'article';
            content = `[专栏] ${major.article.title || ''}`;
            mediaUrls = major.article.covers || [];
        } else if (major?.draw) {
            contentType = 'image';
            content = (desc?.text || '').replace(/#[^#]+#/g, '').trim();
            mediaUrls = (major.draw.items || []).map(i => i.src || '');
        } else if (major?.opus) {
            contentType = 'post';
            content = (major.opus.summary?.text || major.opus.title || desc?.text || '').replace(/#[^#]+#/g, '').trim();
            mediaUrls = (major.opus.pics || []).map(p => p.url || '');
        } else {
            contentType = 'text';
            content = (desc?.text || '').replace(/#[^#]+#/g, '').trim();
        }

        return {
            id: item.id_str || item.id || '',
            type: contentType,
            content: content.substring(0, 500),
            author: { name: author?.name || '', uid: author?.mid || 0, avatar: author?.face || '' },
            media_urls: mediaUrls.slice(0, 4),
            stats: {
                likes: formatCount(stat?.like?.count),
                comments: formatCount(stat?.comment?.count),
                reposts: formatCount(stat?.forward?.count),
            },
            time: mod.module_author?.pub_time || '',
            url: `https://t.bilibili.com/${item.id_str || item.id}`,
        };
    });

    return {
        type: 'dynamic_list',
        uid: uid,
        count: items.length,
        has_more: feed.has_more || false,
        items: items,
    };
}

// ── 4. 评论列表 ──
async function execCommentList(args) {
    let oid = args.oid || '';
    const ctype = args.type || 1;
    const limit = Math.min(args.limit || 20, 40);

    // 对视频BV号需要转成 avid
    if (ctype === 1 && /^BV/i.test(oid)) {
        try {
            const info = await biliGet('/x/web-interface/view', { bvid: oid });
            oid = String(info.aid || oid);
        } catch (e) { /* 保留原值 */ }
    }
    // 专栏 cv 号转数字
    if (ctype === 12) {
        oid = extractCvid(oid);
    }

    const replies = await biliGet('/x/v2/reply', {
        type: ctype,
        oid: oid,
        ps: limit,
        sort: 1, // 1=热门, 0=最新
    });

    const comments = (replies.replies || []).slice(0, limit).map(r => ({
        id: r.rpid,
        user: { name: r.member?.uname || '', uid: r.member?.mid || 0, avatar: r.member?.avatar || '' },
        content: (r.content?.message || '').substring(0, 300),
        likes: r.like || 0,
        replies_count: r.rcount || 0,
        time: r.ctime ? new Date(r.ctime * 1000).toISOString() : '',
        // 子回复(楼中楼, 最多3条)
        sub_replies: (r.replies || []).slice(0, 3).map(sr => ({
            user: { name: sr.member?.uname || '', uid: sr.member?.mid || 0 },
            content: (sr.content?.message || '').substring(0, 200),
            likes: sr.like || 0,
        })),
    }));

    return {
        type: 'comments',
        oid: oid,
        comment_type: ctype === 1 ? '视频' : ctype === 12 ? '专栏' : ctype === 17 ? '动态' : '其他',
        count: comments.length,
        total: replies.page?.acount || 0,
        comments: comments,
    };
}

// ── 5. 搜索 ──
async function execSearch(args) {
    const keyword = args.keyword || '';
    const searchType = args.search_type || 'video';
    const limit = Math.min(args.limit || 10, 25);

    const typeMap = {
        video: { type: 2, name: '视频' },
        article: { type: 12, name: '专栏' },
        bili_user: { type: 8, name: '用户' },
    };

    const st = typeMap[searchType] || typeMap.video;
    const result = await biliGet('/x/web-interface/wbi/search/type', {
        keyword: keyword,
        search_type: String(st.type),
        page: 1,
    });

    // 尝试新版搜索接口
    let items = [];
    if (result.result) {
        items = (result.result || []).slice(0, limit).map(r => {
            if (searchType === 'video' || searchType === undefined) {
                return {
                    type: 'video',
                    bvid: r.bvid, avid: r.aid,
                    title: r.title?.replace(/<[^>]+>/g, ''),
                    author: r.author || '',
                    description: (r.description || '').replace(/<[^>]+>/g, '').substring(0, 200),
                    cover: r.pic || '',
                    duration: r.duration || '',
                    views: formatCount(r.play), danmaku: formatCount(r.video_review),
                    pubdate: r.pubdate ? new Date(r.pubdate * 1000).toISOString().split('T')[0] : '',
                    url: `https://www.bilibili.com/video/${r.bvid}`,
                    tags: (r.tag || '').split(',').filter(Boolean),
                };
            } else if (searchType === 'article') {
                return {
                    type: 'article',
                    id: r.id,
                    title: r.title?.replace(/<[^>]+>/g, ''),
                    author: r.author || '',
                    summary: (r.description || r.summary || '').replace(/<[^>]+>/g, '').substring(0, 200),
                    views: formatCount(r.play || r.view),
                    url: `https://www.bilibili.com/read/cv${r.id}`,
                };
            } else if (searchType === 'bili_user') {
                return {
                    type: 'user',
                    uid: r.mid,
                    name: r.uname || '',
                    signature: r.usign || '',
                    followers: formatCount(r.fans),
                    videos_count: r.videos || 0,
                    avatar: r.upic || '',
                    url: `https://space.bilibili.com/${r.mid}`,
                };
            }
        });
    }

    return {
        type: 'search',
        keyword: keyword,
        search_type: st.name,
        count: items.length,
        total: result.numResults || result.page?.numResults || 0,
        results: items,
    };
}

// ── 6. 用户主页 ──
async function execUserProfile(args) {
    const uid = extractUid(args.uid || '');

    const info = await biliGet('/x/space/acc/info', { mid: uid });
    // 获取用户投稿统计
    let videoStats = {};
    try {
        const statData = await biliGet('/x/space/arc/search', { mid: uid, ps: 1, pn: 1 });
        videoStats.total = statData.page?.count || 0;
        // 最近投稿的几条
        videoStats.recent = (statData.list?.vlist || statData.list || []).slice(0, 5).map(v => ({
            bvid: v.bvid, title: v.title, views: formatCount(v.play),
            cover: v.pic || '', url: `https://www.bilibili.com/video/${v.bvid}`,
        }));
    } catch (e) { /* 无投稿 */ }

    return {
        type: 'user_profile',
        uid: info.mid,
        name: info.name || '',
        sex: info.sex || '',
        level: info.level || 0,
        signature: info.sign || '',
        avatar: info.face || '',
        top_photo: info.top_photo || '',
        birthday: info.birthday || '',
        stats: {
            following: info.following || 0,
            followers: formatCount(info.follower || info.fans || 0),
        },
        is_vip: !!(info.vip?.status),
        official: info.official?.title || '',
        videos_count: videoStats.total || 0,
        recent_videos: videoStats.recent || [],
        url: `https://space.bilibili.com/${uid}`,
        live_status: info.live_room?.liveStatus === 1 ? '直播中' : '未开播',
        live_url: info.live_room?.liveStatus === 1 ? `https://live.bilibili.com/${info.live_room?.roomid}` : null,
    };
}

// ═══════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════

function formatCount(num) {
    if (!num && num !== 0) return '0';
    num = parseInt(num);
    if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
    if (num >= 10000) return (num / 10000).toFixed(1) + '万';
    return String(num);
}

function formatDuration(seconds) {
    if (!seconds) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = n => n < 10 ? '0' + n : n;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function parseArticleContent(html) {
    if (!html) return '';
    // B站专栏使用特殊的 XML/HTML 混合格式
    let text = html
        .replace(/<[^>]+>/g, '\n')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (text.length > 8000) text = text.substring(0, 8000) + '\n\n[...文章过长已截断]';
    return text;
}

// ═══════════════════════════════════════════════════
// MCP 接口 (与 api-tools.js 保持一致的调用约定)
// ═══════════════════════════════════════════════════

function sendJson(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data, null, 2));
}

async function handleBiliToolList(req, res) {
    sendJson(res, 200, { tools: BILIBILI_TOOLS, count: BILIBILI_TOOLS.length });
}

async function handleBiliToolCall(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        let data;
        try { data = JSON.parse(body); } catch (e) { sendJson(res, 400, { error: 'Invalid JSON' }); return; }

        const name = data.name;
        const args = data.arguments || {};
        if (!name) { sendJson(res, 400, { error: 'name required' }); return; }

        const tool = BILIBILI_TOOLS.find(t => t.name === name);
        if (!tool) {
            sendJson(res, 400, { error: `Unknown bilibili tool: ${name}`, available: BILIBILI_TOOLS.map(t => t.name) });
            return;
        }

        try {
            const result = await execBilibiliTool(name, args);
            sendJson(res, 200, { result });
        } catch (e) {
            sendJson(res, 500, { error: e.message, tool: name });
        }
    });
}

module.exports = { BILIBILI_TOOLS, execBilibiliTool, handleBiliToolList, handleBiliToolCall };
