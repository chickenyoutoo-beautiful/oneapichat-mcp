#!/usr/bin/env node
/**
 * MCP Backend Service - Image Analysis
 * 为 oneapichat 提供图片分析后端服务
 * 
 * 运行方式:
 *   node /home/naujtrats/mcp-server/server.js
 *   # 或通过 systemd 管理
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { handleToolList, handleToolCall } = require('./api-tools.js');
const { handleBiliToolList, handleBiliToolCall } = require('./bilibili-tools.js');

// ==================== 配置 ====================
const PORT = parseInt(process.env.MCP_PORT) || 18788;
const HOST = process.env.MCP_HOST || '127.0.0.1';
const LOG_DIR = process.env.MCP_LOG_DIR || '/home/naujtrats/mcp-server/logs';

// Vision API 配置（通过环境变量或默认值）
const VISION_CONFIG = {
    // MiniMax Token Plan 视觉理解端点
    baseUrl: process.env.VISION_BASE_URL || 'https://api.minimaxi.com/v1/coding_plan/vlm',
    // 注意：MiniMax 使用特殊的 Base64 格式图片
    apiKey: process.env.VISION_API_KEY || '',
    model: process.env.VISION_MODEL || 'MiniMax-M2',
    maxTokens: parseInt(process.env.VISION_MAX_TOKENS) || 1024,
    timeout: parseInt(process.env.VISION_TIMEOUT) || 60000,
};

// ==================== 日志 ====================
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
const logFile = path.join(LOG_DIR, 'mcp-server.log');

function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const line = JSON.stringify({ timestamp, level, message, ...data });
    const prefix = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : '✅';
    console.log(`${prefix} [${timestamp}] ${message}`);
    try {
        fs.appendFileSync(logFile, line + '\n');
    } catch(e) {}
}

// ==================== Vision API 调用 ====================
function callVisionAPI(imageBase64, prompt) {
    return new Promise((resolve, reject) => {
        // MiniMax /coding_plan/vlm 格式 (专用视觉理解接口)
        const fullUrl = VISION_CONFIG.baseUrl;
        const parsedUrl = new URL(fullUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        // MiniMax coding_plan/vlm 视觉格式
        const requestBody = JSON.stringify({
            model: VISION_CONFIG.model, // MiniMax-VL-01 或 MiniMax-M2
            prompt: prompt || '请详细描述这张图片的内容',
            image_url: imageBase64 // 包含 data:image/...;base64, 前缀
        });

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${VISION_CONFIG.apiKey}`,
                'Content-Length': Buffer.byteLength(requestBody),
            },
            timeout: VISION_CONFIG.timeout,
        };

        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        function doRequest(opts) {
            const req = httpModule.request(opts, (res) => {
                // 处理重定向
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirectCount < MAX_REDIRECTS) {
                    redirectCount++;
                    const redirectUrl = new URL(res.headers.location, fullUrl);
                    const redirectParsed = new URL(redirectUrl);
                    const redirectHttp = redirectParsed.protocol === 'https:' ? https : http;
                    const redirectOpts = {
                        hostname: redirectParsed.hostname,
                        port: redirectParsed.port || (redirectParsed.protocol === 'https:' ? 443 : 80),
                        path: redirectParsed.pathname + redirectParsed.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${VISION_CONFIG.apiKey}`,
                            'Content-Length': Buffer.byteLength(requestBody),
                        },
                        timeout: VISION_CONFIG.timeout,
                    };
                    console.log(`[MCP] 重定向到: ${redirectUrl}`);
                    doRequest(redirectOpts);
                    return;
                }

                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        // MiniMax /coding_plan/vlm 返回格式
                        // 优先检查 content 字段（coding_plan/vlm 格式）
                        const content = data.content || data.choices?.[0]?.message?.content;
                        if (content) {
                            resolve(content);
                        } else if (data.base_resp?.status_code !== 0) {
                            const msg = data.base_resp?.status_msg || 'Unknown error';
                            if (msg && (msg.includes('sensitive') || msg.includes('Sensitive'))) {
                                reject(new Error('⚠️ 图片内容被 MiniMax 标记为敏感，请尝试其他图片'));
                            } else if (msg && (msg.includes('invalid') || msg.includes('Invalid'))) {
                                reject(new Error('⚠️ MiniMax 不支持此图片格式或图片数据无效'));
                            } else {
                                reject(new Error('MiniMax API 错误: ' + (msg || JSON.stringify(data))));
                            }
                        } else if (data.error) {
                            reject(new Error(data.error.message || JSON.stringify(data.error)));
                        } else {
                            reject(new Error('未知响应格式: ' + body.slice(0, 200)));
                        }
                    } catch (e) {
                        reject(new Error('响应解析失败: ' + body.slice(0, 200)));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Vision API 请求超时')); });
            req.write(requestBody);
            req.end();
        }

        doRequest(options);
    });
}

// 文本降级: 返回 helpful 的降级信息
function textFallbackResponse(prompt) {
    const advice = [
        '[图片分析失败] 图片分析服务暂时不可用。',
        '',
        '可能原因:',
        '1. 图片格式不被支持（支持的格式: JPEG、PNG、GIF、WebP）',
        '2. 图片太大或太小',
        '3. 网络连接问题',
        '',
        '建议:',
        '1. 尝试压缩图片或转换为 JPEG/PNG 格式',
        '2. 稍后再试',
    ];
    return advice.join('\n');
}

// ==================== HTTP 处理器 ====================
async function handleAnalyze(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            let image = data.image;
            const imageUrl = data.image_url;
            
            if (!image && !imageUrl) {
                sendJson(res, 400, { error: '缺少 image 或 image_url 参数' });
                return;
            }

            // ★ 支持 image_url: 从本地文件系统读取或 URL 下载
            if (!image && imageUrl) {
                try {
                    log('INFO', '获取图片', { url: imageUrl.substring(0, 80) });
                    var imgBuf = null;
                    var imgMime = null;

                    // 尝试本地文件读取(图片通过 upload.php 已保存在本地)
                    var localMatch = imageUrl.match(/\/oneapichat\/uploads\/(.+)$/);
                    if (localMatch) {
                        var localPath = '/var/www/html/oneapichat/uploads/' + localMatch[1];
                        if (fs.existsSync(localPath)) {
                            var imgData = fs.readFileSync(localPath);
                            var ext = path.extname(localPath).slice(1).toLowerCase();
                            var mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', bmp:'image/bmp' };
                            imgMime = mimeMap[ext] || 'image/png';
                            imgBuf = 'data:' + imgMime + ';base64,' + imgData.toString('base64');
                            log('INFO', '本地文件读取成功', { path: localPath, len: imgBuf.length });
                        }
                    }

                    // 本地读取失败或不是本地路径,回退到 HTTP 下载
                    if (!imgBuf) {
                        var urlObj = new URL(imageUrl);
                        var httpMod = urlObj.protocol === 'https:' ? https : http;
                        imgBuf = await new Promise(function(resolve, reject) {
                            httpMod.get(imageUrl, function(imgRes) {
                                if (imgRes.statusCode !== 200) {
                                    reject(new Error('HTTP ' + imgRes.statusCode));
                                    return;
                                }
                                imgMime = imgRes.headers['content-type'] || 'image/png';
                                var chunks = [];
                                imgRes.on('data', function(c) { chunks.push(c); });
                                imgRes.on('end', function() {
                                    var b64 = Buffer.concat(chunks).toString('base64');
                                    resolve('data:' + imgMime + ';base64,' + b64);
                                });
                            }).on('error', reject);
                        });
                        log('INFO', 'HTTP 下载完成', { len: imgBuf.length });
                    }

                    image = imgBuf;
                } catch(e) {
                    log('ERROR', '获取图片失败', { error: e.message });
                    sendJson(res, 400, { error: '获取图片失败: ' + e.message });
                    return;
                }
            }

            log('INFO', '收到图片分析请求', { 
                promptLen: (data.prompt || '').length, 
                imageLen: image.length,
                source: imageUrl ? 'url' : 'base64'
            });

            let result;
            let apiUsed = 'none';

            // 尝试调用 Vision API
            if (VISION_CONFIG.apiKey) {
                try {
                    log('INFO', '调用 MiniMax Vision API', { model: VISION_CONFIG.model });
                    result = await callVisionAPI(image, data.prompt);
                    apiUsed = 'MiniMax Token Plan (api.minimaxi.com)';
                    log('INFO', 'Vision API 成功', { resultLen: result.length });
                } catch (e) {
                    log('WARN', 'Vision API 失败，降级处理', { error: e.message });
                    const msg = e.message;
                    if (msg && (msg.includes('敏感') || msg.includes('sensitive'))) {
                        // 图片被标记为敏感：返回明确的错误信息
                        result = '[图片分析失败] 图片被 MiniMax 内容审核拦截，无法进行分析。这说明图片内容未通过模型的安全审核，不代表图片不存在。请尝试其他图片。';
                    } else if (msg && (msg.includes('invalid') || msg.includes('Invalid') || msg.includes('无效'))) {
                        // 图片数据无效（太小、损坏、不支持）
                        result = '[图片分析失败] 图片数据无效，可能是图片太小、格式不支持或已损坏。建议：1) 尝试更大的图片（至少10x10像素）2) 转换为 JPEG/PNG 格式 3) 重新截图后上传。';
                    } else {
                        // 其他错误
                        result = '[图片分析失败] ' + (msg || '未知错误');
                    }
                    apiUsed = 'fallback';
                }
            } else {
                log('WARN', '未配置 VISION_API_KEY，使用文本降级');
                result = textFallbackResponse(data.prompt);
                apiUsed = 'fallback';
            }

            sendJson(res, 200, { result, apiUsed });
        } catch (e) {
            log('ERROR', '请求处理失败', { error: e.message });
            sendJson(res, 400, { error: '请求格式错误: ' + e.message });
        }
    });
}

function handleFetchUrl(req, res) {
    try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let url;
            try {
                const data = JSON.parse(body);
                url = data.url || data.targetUrl || data.link;
            } catch {
                // 尝试从 query string 获取
                const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
                url = parsedUrl.searchParams.get('url') || parsedUrl.searchParams.get('targetUrl');
            }
            if (!url) {
                sendJson(res, 400, { error: '缺少 url 参数' });
                return;
            }
            // 简单 URL 校验
            try { new URL(url); } catch { sendJson(res, 400, { error: '无效的 URL 格式' }); return; }
            log('INFO', '开始抓取 URL', { url });
            fetchUrlContent(url)
                .then(content => {
                    log('INFO', 'URL 抓取成功', { url, length: content.length });
                    sendJson(res, 200, { result: content, url });
                })
                .catch(e => {
                    log('WARN', 'URL 抓取失败', { url, error: e.message });
                    sendJson(res, 200, { error: '[URL抓取失败] ' + e.message });
                });
        });
    } catch (e) {
        sendJson(res, 400, { error: '请求格式错误: ' + e.message });
    }
}

function handleHealth(req, res) {
    sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        visionApi: {
            configured: !!VISION_CONFIG.apiKey,
            baseUrl: VISION_CONFIG.baseUrl,
            model: VISION_CONFIG.model,
        },
        memory: process.memoryUsage(),
    });
}

// ==================== MiniMax CLI 代理 ====================
// ★ 直接调用 mmx CLI 二进制（与 engine_api.php case 'mmx' 逻辑一致）
// 绕过 Nginx/PHP 中转，避免 HTTP 路由和证书问题
const MMX_BIN = '/home/naujtrats/.npm-global/bin/mmx';
const MMX_REGION = process.env.MMX_REGION || 'cn';
// API Key: 环境变量优先，fallback 到项目配置
function getMmxApiKey() {
    if (process.env.MMX_API_KEY) return process.env.MMX_API_KEY;
    try {
        const cfgPath = '/var/www/html/oneapichat/config/.mmx_config.json';
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            return cfg.api_key || '';
        }
    } catch(e) {}
    return '';
}

function handleMmxProxy(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const cmd = data.cmd || 'chat';
            const apiKey = data.api_key || getMmxApiKey();
            if (!apiKey || !/^[a-zA-Z0-9_-]+$/.test(apiKey)) {
                sendJson(res, 400, { error: 'MiniMax API Key 未配置或无效' });
                return;
            }

            const region = data.region || MMX_REGION;
            const extraFlags = `--non-interactive --output json --api-key ${apiKey} --region ${region}`;
            const prompt = data.prompt || '';

            // ★ 进程隔离: 创建唯一临时 HOME 目录
            const tmpHome = require('os').tmpdir() + '/mmx_' + process.pid + '_' +
                Math.random().toString(36).substring(2, 10);
            try { fs.mkdirSync(tmpHome, 0o700); } catch(e) {}
            const env = Object.assign({}, process.env, { HOME: tmpHome });

            let cmdStr = '';
            if (cmd === 'chat') {
                const message = data.message || prompt;
                if (!message) { sendJson(res, 400, { error: 'chat 需要 message 参数' }); cleanupTmp(); return; }
                const system = data.system ? ` --system ${esc(data.system)}` : '';
                const maxTokens = data.max_tokens || 4096;
                cmdStr = `${MMX_BIN} text chat --message ${esc(message)}${system} --max-tokens ${maxTokens} ${extraFlags} 2>&1`;
            } else if (cmd === 'image') {
                const aspect = data.aspect_ratio || '1:1';
                const n = parseInt(data.n) || 1;
                cmdStr = `${MMX_BIN} image generate --aspect-ratio ${aspect} --n ${n} ${prompt ? '--prompt ' + esc(prompt) : ''} ${extraFlags} 2>&1`;
            } else if (cmd === 'speech') {
                const text = data.text || prompt;
                if (!text) { sendJson(res, 400, { error: 'speech 需要 text 参数' }); cleanupTmp(); return; }
                const voice = data.voice || 'female-yujie';
                const sharedDir = '/var/www/html/oneapichat/uploads/shared/';
                if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
                const outPath = sharedDir + 'speech_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.mp3';
                cmdStr = `${MMX_BIN} speech synthesize --text ${esc(text)} --voice ${esc(voice)} --out ${outPath} ${extraFlags} 2>&1`;
                // 保存 outPath 以便构造返回 URL
                data._outPath = outPath;
            } else if (cmd === 'voices') {
                cmdStr = `${MMX_BIN} speech voices ${extraFlags} 2>&1`;
            } else if (cmd === 'music') {
                const lyrics = data.lyrics || '';
                const instrumental = data.instrumental;
                let extra = lyrics ? ` --lyrics ${esc(lyrics)}` : ' --lyrics-optimizer';
                if (instrumental) extra += ' --instrumental';
                const sharedDir = '/var/www/html/oneapichat/uploads/shared/';
                if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
                const outPath = sharedDir + 'music_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.mp3';
                cmdStr = `${MMX_BIN} music generate ${extra} --out ${outPath} ${prompt ? '--prompt ' + esc(prompt) : ''} ${extraFlags} 2>&1`;
                data._outPath = outPath;
            } else if (cmd === 'vision') {
                const image = data.image || '';
                if (!image) { sendJson(res, 400, { error: 'vision 需要 image 参数' }); cleanupTmp(); return; }
                cmdStr = `${MMX_BIN} vision describe --image ${esc(image)} ${extraFlags} 2>&1`;
            } else if (cmd === 'quota') {
                cmdStr = `${MMX_BIN} quota show ${extraFlags} 2>&1`;
            } else if (cmd === 'search') {
                const q = data.q || prompt;
                if (!q) { sendJson(res, 400, { error: 'search 需要 q 参数' }); cleanupTmp(); return; }
                const limit = parseInt(data.limit) || 5;
                cmdStr = `${MMX_BIN} search query ${esc(q)} --limit ${limit} ${extraFlags} 2>&1`;
            } else {
                cleanupTmp();
                sendJson(res, 400, { error: `未知命令: ${cmd}, 支持: chat/image/speech/voices/music/vision/search/quota` });
                return;
            }

            log('INFO', 'mmx CLI 执行', { cmd, cmdStr: cmdStr.substring(0, 120) });

            exec(cmdStr, { env, timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                cleanupTmp();
                const output = (stdout || '') + (stderr || '');
                if (err && !output.trim()) {
                    log('ERROR', 'mmx CLI 失败', { cmd, error: err.message });
                    sendJson(res, 500, { error: 'mmx CLI 执行失败: ' + err.message });
                    return;
                }

                // speech/music: 检查文件
                if ((cmd === 'speech' || cmd === 'music') && data._outPath && fs.existsSync(data._outPath) && fs.statSync(data._outPath).size > 100) {
                    const fn = path.basename(data._outPath);
                    const fileUrl = 'https://naujtrats.xyz/oneapichat/uploads/shared/' + fn;
                    sendJson(res, 200, { result: { url: fileUrl, path: '/oneapichat/uploads/shared/' + fn, size: fs.statSync(data._outPath).size }, raw: output });
                    return;
                }

                try {
                    const parsed = JSON.parse(output.trim());
                    sendJson(res, 200, { result: parsed, raw: output });
                } catch(e) {
                    sendJson(res, 200, { result: output.trim() });
                }
            });

            function cleanupTmp() {
                try { if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(e) {}
            }
            function esc(s) { return `"${String(s).replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}"`; }
        } catch (e) {
            log('ERROR', 'mmx 代理解析失败', { error: e.message });
            sendJson(res, 400, { error: 'mmx 代理请求格式错误: ' + e.message });
        }
    });
}

function handleNotFound(req, res) {
    sendJson(res, 404, { error: 'Not Found', path: req.url });
}

// ==================== URL抓取工具 ====================
function fetchUrlContent(targetUrl) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const TIMEOUT = 30000;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; oneapichat/1.0; URL fetcher)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            timeout: TIMEOUT,
        };

        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        function doRequest(opts) {
            const req = httpModule.request(opts, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirectCount < MAX_REDIRECTS) {
                    redirectCount++;
                    try {
                        const redirectUrl = new URL(res.headers.location, targetUrl);
                        const redirectParsed = new URL(redirectUrl);
                        const redirectHttp = redirectParsed.protocol === 'https:' ? https : http;
                        const redirectOpts = {
                            hostname: redirectParsed.hostname,
                            port: redirectParsed.port || (redirectParsed.protocol === 'https:' ? 443 : 80),
                            path: redirectParsed.pathname + redirectParsed.search,
                            method: 'GET',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (compatible; oneapichat/1.0; URL fetcher)',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            },
                            timeout: TIMEOUT,
                        };
                        doRequest(redirectOpts);
                    } catch (e) {
                        reject(new Error('重定向URL解析失败'));
                    }
                    return;
                }


                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const contentType = res.headers['content-type'] || '';
                if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
                    reject(new Error('仅支持 HTML/Text/JSON 页面，实际类型: ' + contentType));
                    return;
                }

                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('内容过长 > 2MB')); } });
                res.on('end', () => {
                    try {
                        const text = extractReadableText(body, targetUrl);
                        resolve(text);
                    } catch (e) {
                        reject(new Error('内容解析失败: ' + e.message));
                    }
                });
                res.on('error', () => reject(new Error('连接读取失败')));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('请求超时 30s')); });
            req.on('error', (e) => reject(new Error('网络错误: ' + e.message)));
            req.end();
        }
        doRequest(options);
    });
}

function extractReadableText(html, sourceUrl) {
    // 移除 script/style
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // 移除注释
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    // 移除所有 HTML 标签
    text = text.replace(/<[^>]+>/g, ' ');
    // 解码 HTML 实体
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    // 合并空白
    text = text.replace(/\s+/g, ' ').trim();
    // 限制长度（防止 token 爆炸）
    const MAX_CHARS = 15000;
    if (text.length > MAX_CHARS) {
        text = text.substring(0, MAX_CHARS) + '\n\n[...内容过长已截断，原文来自: ' + sourceUrl + ']';
    }
    return text;
}

// ==================== 工具函数 ====================
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
}

// ==================== 服务器主循环 ====================
const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = parsedUrl.pathname;

    // CORS 预检
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    // 路由
    if (pathname === '/health' || pathname === '/mcp/health') {
        handleHealth(req, res);
    } else if (pathname === '/analyze' || pathname === '/mcp/analyze') {
        if (req.method === 'POST') {
            handleAnalyze(req, res);
        } else {
            sendJson(res, 405, { error: 'Method Not Allowed, use POST' });
        }
    } else if (pathname === '/fetch_url' || pathname === '/mcp/fetch_url') {
        if (req.method === 'POST' || req.method === 'GET') {
            handleFetchUrl(req, res);
        } else {
            sendJson(res, 405, { error: 'Method Not Allowed, use POST or GET' });
        }
    } else if (pathname === '/mmx' || pathname === '/mcp/mmx') {
        if (req.method === 'POST') {
            handleMmxProxy(req, res);
        } else {
            sendJson(res, 405, { error: 'Method Not Allowed, use POST' });
        }
    } else if (pathname === '/mcp/api/tools' || pathname === '/api/tools') {
        handleToolList(req, res);
    } else if (pathname === '/mcp/api/tools/call' || pathname === '/api/tools/call') {
        if (req.method === 'POST') {
            handleToolCall(req, res);
        } else {
            sendJson(res, 405, { error: 'Method Not Allowed, use POST' });
        }
    } else if (pathname.startsWith('/bilibili/qr/')) {
        // 二维码图片服务
        const qrFile = path.join(__dirname, pathname.replace('/bilibili/qr/', ''));
        if (fs.existsSync(qrFile) && qrFile.endsWith('.png')) {
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
            });
            fs.createReadStream(qrFile).pipe(res);
        } else {
            sendJson(res, 404, { error: 'QR image not found' });
        }
    } else if (pathname === '/mcp/bilibili/tools' || pathname === '/bilibili/tools') {
        handleBiliToolList(req, res);
    } else if (pathname === '/mcp/bilibili/tools/call' || pathname === '/bilibili/tools/call') {
        if (req.method === 'POST') {
            handleBiliToolCall(req, res);
        } else {
            sendJson(res, 405, { error: 'Method Not Allowed, use POST' });
        }
    } else {
        handleNotFound(req, res);
    }
});

// ==================== 优雅关闭 ====================
function shutdown() {
    log('INFO', '正在关闭服务...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
    log('ERROR', '未捕获异常', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
    log('ERROR', '未处理 Promise 拒绝', { reason: String(reason) });
});

// ==================== 启动 ====================
server.listen(PORT, HOST, () => {
    log('INFO', `MCP Server 启动成功`, { 
        host: HOST, 
        port: PORT,
        visionConfigured: !!VISION_CONFIG.apiKey,
        visionModel: VISION_CONFIG.model,
        visionUrl: VISION_CONFIG.baseUrl,
    });
});