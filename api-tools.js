// OneAPIChat API Tools — MCP Adapter v2
// Dynamically loads tools from engine + API, routes execution

const fs = require('fs');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { BILIBILI_TOOLS, execBilibiliTool } = require('./bilibili-tools.js');

// ── Special tools (handled in Node.js directly) ──
const SPECIAL_TOOLS = [
    { name: "web_search", description: "搜索互联网获取实时信息。", inputSchema: { type: "object", properties: { query: { type: "string", description: "搜索关键词" }, max_results: { type: "integer", description: "最大结果数，默认5" } }, required: ["query"] } },
    { name: "web_fetch", description: "抓取网页内容提取文本信息。", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, description: "要抓取的URL列表" } }, required: ["urls"] } },
    { name: "generate_image", description: "使用AI生成图片。", inputSchema: { type: "object", properties: { prompt: { type: "string", description: "图片生成提示词" } }, required: ["prompt"] } },
];

// ── Engine tool cache ──
let _engineTools = [];
let _allTools = null;

function loadEngineTools() {
    return new Promise((resolve) => {
        if (_engineTools.length > 0) { resolve(_engineTools); return; }
        const req = http.get('http://127.0.0.1:8766/engine/v2/tools/list', { timeout: 3000 }, (resp) => {
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    _engineTools = (data.tools || []).map(t => ({
                        name: t.name,
                        description: t.description || '',
                        inputSchema: t.input_schema || t.parameters || { type: 'object', properties: {} },
                        capabilities: t.capabilities || [],
                    }));
                } catch(e) { _engineTools = []; }
                resolve(_engineTools);
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
    });
}

async function getAllTools() {
    if (_allTools) return _allTools;
    const engineTools = await loadEngineTools();
    const merged = [...SPECIAL_TOOLS];
    const seen = new Set(SPECIAL_TOOLS.map(t => t.name));
    for (const t of [...engineTools, ...EXTRA_TOOLS, ...BILIBILI_TOOLS]) {
        if (!seen.has(t.name)) { merged.push(t); seen.add(t.name); }
    }
    _allTools = merged;
    return _allTools;
}

// ── Extra tools — full coverage (前端 100+ 工具统一通过 MCP) ──
const EXTRA_TOOLS = [
    // 服务器
    { name: "server_file_search", description: "按文件名模式搜索文件。", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
    { name: "server_file_grep", description: "在文件内容中搜索文本(grep)。", inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, max_results: { type: "integer" } }, required: ["pattern"] } },
    { name: "server_file_edit", description: "替换文件中的字符串。", inputSchema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path","old_string","new_string"] } },
    { name: "server_file_op", description: "文件操作：cp/mv/rm/mkdir。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["cp","mv","rm","mkdir"] }, src: { type: "string" }, dst: { type: "string" } }, required: ["action"] } },
    { name: "server_ps", description: "查看服务器进程列表。", inputSchema: { type: "object", properties: { filter: { type: "string" } }, required: [] } },
    { name: "server_disk", description: "查看服务器磁盘使用情况。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] } },
    { name: "server_network", description: "网络诊断：ping/curl/端口。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["ping","curl","port"] }, target: { type: "string" } }, required: ["action","target"] } },
    { name: "server_docker", description: "Docker容器管理：ps/start/stop/logs。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["ps","start","stop","logs","restart"] }, name: { type: "string" } }, required: ["action"] } },
    { name: "server_db_query", description: "查询SQLite数据库。", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
    // 媒体/创作
    { name: "generate_ppt", description: "生成PPT演示文稿。pages为JSON数组:[{type:'cover',title:'标题',subtitle:'副标题'},{type:'divider',title:'章节'},{type:'card_grid',rows:2,cols:2,cards:[{title:'卡片',bullets:['要点1']}]}]。", inputSchema: { type: "object", properties: { title: { type: "string", description: "PPT标题" }, pages: { type: "string", description: "页面JSON数组" }, theme: { type: "string", description: "主题:default/modern/dark" }, filename: { type: "string" } }, required: ["title","pages"] } },
    { name: "video_understanding", description: "分析理解视频内容。", inputSchema: { type: "object", properties: { url: { type: "string" }, query: { type: "string" } }, required: ["url"] } },
    { name: "analyze_image", description: "分析图片内容。支持URL或base64。", inputSchema: { type: "object", properties: { image_url: { type: "string", description: "图片URL或base64(data:image/...)" }, image: { type: "string", description: "图片URL或base64(同image_url)" }, prompt: { type: "string", description: "分析提示" } }, required: [] } },
    { name: "rag_search", description: "搜索知识库(RAG)获取私有文档信息。", inputSchema: { type: "object", properties: { q: { type: "string", description: "搜索查询" }, collection: { type: "string", description: "知识库名称,默认default" }, top_k: { type: "integer", description: "返回条数,默认5" } }, required: ["q"] } },
    // 文档生成
    { name: "generate_docx", description: "生成 Word 文档(.docx)。content 为 JSON 数组 [{type:'h1'|'h2'|'p'|'bullet', text:''}]。", inputSchema: { type: "object", properties: { title: { type: "string", description: "文档标题" }, content: { type: "string", description: "内容JSON数组" }, filename: { type: "string" } }, required: ["title","content"] } },
    { name: "generate_xlsx", description: "生成 Excel 表格(.xlsx)。rows 为 JSON 二维数组, headers 为可选的 JSON 字符串数组。", inputSchema: { type: "object", properties: { title: { type: "string", description: "表格标题" }, rows: { type: "string", description: "数据行JSON数组" }, headers: { type: "string", description: "表头JSON数组" }, filename: { type: "string" } }, required: ["rows"] } },
    { name: "generate_pdf", description: "生成 PDF 文档。content 为 JSON 数组 [{type:'h1'|'h2'|'p'|'bullet', text:''}]。", inputSchema: { type: "object", properties: { title: { type: "string", description: "文档标题" }, content: { type: "string", description: "内容JSON数组" }, filename: { type: "string" } }, required: ["title","content"] } },
    // Agent/编排
    { name: "plan_update", description: "创建/更新/完成计划面板。action: create/update/complete。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create","update","complete"] }, plan: { type: "object" }, task_id: { type: "string" }, status: { type: "string" } }, required: ["action"] } },
    { name: "delegate_task", description: "委托任务给子代理执行。", inputSchema: { type: "object", properties: { task: { type: "string" }, agent_role: { type: "string" } }, required: ["task"] } },
    { name: "delegate_workflow", description: "创建有依赖关系的工作流。", inputSchema: { type: "object", properties: { steps: { type: "array" } }, required: ["steps"] } },
    { name: "ask_agent", description: "请求Agent授权/对话。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
    // MiniMax (8 tools)
    { name: "mmx_chat", description: "MiniMax对话(备用模型)。", inputSchema: { type: "object", properties: { message: { type: "string" }, system: { type: "string" }, max_tokens: { type: "integer" } }, required: ["message"] } },
    { name: "mmx_image", description: "MiniMax图片生成。", inputSchema: { type: "object", properties: { prompt: { type: "string" }, aspect_ratio: { type: "string" }, n: { type: "integer" } }, required: ["prompt"] } },
    { name: "mmx_speech", description: "MiniMax文字转语音(TTS)。", inputSchema: { type: "object", properties: { text: { type: "string" }, voice: { type: "string" } }, required: ["text"] } },
    { name: "mmx_music", description: "MiniMax音乐生成。", inputSchema: { type: "object", properties: { prompt: { type: "string" }, lyrics: { type: "string" } }, required: ["prompt"] } },
    { name: "mmx_voices", description: "MiniMax音色列表。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "mmx_vision", description: "MiniMax图片分析。", inputSchema: { type: "object", properties: { image: { type: "string" } }, required: ["image"] } },
    { name: "mmx_quota", description: "MiniMax配额查询。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "mmx_video", description: "MiniMax视频生成。", inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
    // Cloudreve 云盘
    { name: "cr_login", description: "登录Cloudreve云盘(session缓存24h)。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "cr_user_info", description: "获取当前云盘用户信息。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "cr_list_files", description: "列出云盘目录文件。", inputSchema: { type: "object", properties: { path: { type: "string", description: "目录路径, 默认根目录/" } }, required: [] } },
    { name: "cr_search_files", description: "搜索云盘文件。", inputSchema: { type: "object", properties: { keyword: { type: "string" }, path: { type: "string" } }, required: ["keyword"] } },
    { name: "cr_create_folder", description: "创建云盘文件夹。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "cr_rename", description: "重命名云盘文件/夹。", inputSchema: { type: "object", properties: { path: { type: "string" }, new_name: { type: "string" } }, required: ["path","new_name"] } },
    { name: "cr_move", description: "移动文件/夹。", inputSchema: { type: "object", properties: { src: { type: "string" }, dst: { type: "string" } }, required: ["src","dst"] } },
    { name: "cr_copy", description: "复制文件/夹。", inputSchema: { type: "object", properties: { src: { type: "string" }, dst: { type: "string" } }, required: ["src","dst"] } },
    { name: "cr_delete", description: "删除文件/夹。", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "cr_list_shares", description: "列出分享链接。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "cr_create_share", description: "创建文件分享链接。", inputSchema: { type: "object", properties: { path: { type: "string" }, password: { type: "string" } }, required: ["path"] } },
    { name: "cr_delete_share", description: "删除分享链接。", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "cr_storage_info", description: "查询云盘存储空间。", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "cr_overview", description: "云盘概览(文件数+存储+分享)。", inputSchema: { type: "object", properties: {}, required: [] } },
    // Chaoxing QR 登录
    { name: "chaoxing_qr_login", description: "超星学习通扫码登录。①action=qr或auto→生成QR(立即返回,非阻塞) ②拿到enc+uuid后立即调action=login(enc,uuid)→阻塞等待用户扫码。login会先用传入的enc/uuid轮询;若QR过期则返回新QR→重复①②直到登录成功。不要跳过第①步!", inputSchema: { type: "object", properties: { action: { type: "string", description: "check=检查cookie / qr或auto=生成二维码(非阻塞) / login=等待扫码(阻塞,传入enc+uuid优先)", enum: ["check", "qr", "auto", "login"] }, enc: { type: "string", description: "login时传入(由qr/auto步骤返回)" }, uuid: { type: "string", description: "login时传入(由qr/auto步骤返回)" }, timeout: { type: "integer", description: "login超时秒数,默认300" } }, required: ["action"] } },
];

// ── Engine proxy — comprehensive routing ──
const ENGINE_MAP = {
    // 服务器工具
    server_sys_info: 'sys/info', server_file_read: 'file/read', server_file_write: 'file/write',
    server_file_append: 'file/write', server_file_search: 'file_search', server_file_grep: 'file_grep',
    server_file_edit: 'file_edit', server_file_op: 'file_op', server_exec: 'exec',
    server_python: 'python', server_ps: 'ps', server_disk: 'disk', server_network: 'network',
    server_docker: 'docker', server_db_query: 'db_query',
    // 浏览器
    browser_navigate: 'browser/navigate', browser_screenshot: 'browser/screenshot',
    browser_click: 'browser/click', browser_type: 'browser/type',
    browser_get_content: 'browser/get_content', browser_get_snapshot: 'browser/get_snapshot',
    // 媒体/内容
    platform_extract: 'platform_extract', run_skill: 'skills/run',
    video_edit: 'video_edit', video_understanding: 'video/understanding',
    generate_ppt: 'ppt/generate', generate_image: 'image/generate',
    rag_search: 'rag/search',
    // 文档生成
    generate_docx: 'docx/generate', generate_xlsx: 'xlsx/generate', generate_pdf: 'pdf/generate',
    // Cloudreve 云盘
    cr_login: '__cr/login', cr_user_info: '__cr/user_info', cr_list_files: '__cr/list_files',
    cr_search_files: '__cr/search_files', cr_create_folder: '__cr/create_folder',
    cr_rename: '__cr/rename', cr_move: '__cr/move', cr_copy: '__cr/copy', cr_delete: '__cr/delete',
    cr_list_shares: '__cr/list_shares', cr_create_share: '__cr/create_share',
    cr_delete_share: '__cr/delete_share', cr_storage_info: '__cr/storage_info', cr_overview: '__cr/overview',
    // Agent/编排
    engine_agent_create: 'agent/create', engine_agent_list: 'agent/list',
    engine_agent_status: 'agent/status', engine_agent_run: 'agent/run',
    engine_agent_ask: 'agent/ask', engine_agent_stop: 'agent/stop',
    engine_agent_delete: 'agent/delete',
    engine_cron_create: 'cron/create', engine_cron_list: 'cron/list',
    engine_cron_delete: 'cron/delete',
    delegate_task: 'agent/delegate', delegate_workflow: 'workflow/create',
    plan_update: 'workflow/plan',
    // Windows
    win_info: 'win/info', win_processes: 'win/processes',
    win_kill: 'win/kill', win_start: 'win/start', win_restart: 'win/restart',
    win_file: 'win/file', win_screenshot: 'win/screenshot',
    // MiniMax (proxied through /mmx)
    mmx_chat: '__mmx', mmx_image: '__mmx', mmx_video: '__mmx',
    mmx_speech: '__mmx', mmx_music: '__mmx', mmx_voices: '__mmx',
    mmx_vision: '__mmx', mmx_quota: '__mmx',
    // Misc
    engine_push: '__push_file', ask_agent: 'agent/ask_permission',
    autonomous_mode: 'agent/mode', toggle_proxy: 'config/toggle_proxy',
};

function sendJson(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

async function handleToolList(req, res) {
    const tools = await getAllTools();
    sendJson(res, 200, { tools });
}

function handleToolCall(req, res) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        let data;
        try { data = JSON.parse(body); } catch(e) { sendJson(res, 400, { error: 'Invalid JSON' }); return; }
        const name = data.name;
        const args = data.arguments || {};
        if (!name) { sendJson(res, 400, { error: 'name required' }); return; }

        const tools = await getAllTools();
        if (!tools.find(t => t.name === name)) {
            sendJson(res, 400, { error: 'Unknown tool: ' + name, available: tools.map(t => t.name) });
            return;
        }

        try {
            const result = await execTool(name, args);
            sendJson(res, 200, { result });
        } catch(e) {
            sendJson(res, 500, { error: e.message });
        }
    });
}

async function execTool(name, args) {
    switch (name) {
        case 'web_search': return execWebSearch(args);
        case 'web_fetch': return execWebFetch(args);
        case 'generate_image': return execImageGen(args);
        case 'analyze_image': return execAnalyzeImage(args);
        case 'video_understanding': return execAnalyzeImage(args);  // same vision analysis
        case 'engine_push': return execPushFile(args);
        default:
            // ★ Chaoxing QR 登录: 独立 Python 脚本
            if (name === 'chaoxing_qr_login') {
                return execChaoxingQrLogin(args);
            }
            // ★ Bilibili 工具: 委托给 bilibili-tools.js
            if (name.startsWith('bilibili_')) {
                return execBilibiliTool(name, args);
            }
            // ★ MiniMax 工具: 委托给 MMX CLI
            if (name.startsWith('mmx_')) {
                return execMmxTool(name, args);
            }
            const enginePath = ENGINE_MAP[name];
            if (enginePath) return execEngineProxy(enginePath, args);
            throw new Error('No handler for: ' + name);
    }
}

// ── MiniMax CLI 执行 ──
function execMmxTool(name, args) {
    return new Promise((resolve, reject) => {
        const cmd = name.replace('mmx_', '');
        const extraFlags = `--non-interactive --output json`;
        const mmxBin = '/home/naujtrats/.npm-global/bin/mmx';

        // API Key
        let apiKey = process.env.MMX_API_KEY || '';
        if (!apiKey) {
            try { apiKey = JSON.parse(fs.readFileSync('/var/www/html/oneapichat/config/.mmx_config.json', 'utf8')).api_key || ''; } catch(e) {}
        }
        const region = process.env.MMX_REGION || 'cn';
        const flag = `${extraFlags} --api-key ${apiKey} --region ${region}`;

        let cmdStr = '';
        const esc = s => `"${String(s).replace(/"/g, '\\"')}"`;

        if (cmd === 'chat') {
            cmdStr = `${mmxBin} text chat --message ${esc(args.message||args.prompt||'')} --max-tokens ${args.max_tokens||4096} ${flag}`;
        } else if (cmd === 'image') {
            cmdStr = `${mmxBin} image generate --prompt ${esc(args.prompt||'')} --aspect-ratio ${args.aspect_ratio||'1:1'} --n ${args.n||1} ${flag}`;
        } else if (cmd === 'speech') {
            const outPath = `/var/www/html/oneapichat/uploads/shared/speech_${Date.now()}.mp3`;
            cmdStr = `${mmxBin} speech synthesize --text ${esc(args.text||args.prompt||'')} --voice ${esc(args.voice||'female-yujie')} --out ${outPath} ${flag}`;
            args._outPath = outPath;
        } else if (cmd === 'music') {
            const outPath = `/var/www/html/oneapichat/uploads/shared/music_${Date.now()}.mp3`;
            const lyricsFlag = args.lyrics ? ` --lyrics ${esc(args.lyrics)}` : ' --lyrics-optimizer';
            cmdStr = `${mmxBin} music generate ${lyricsFlag} --out ${outPath} --prompt ${esc(args.prompt||'')} ${flag}`;
            args._outPath = outPath;
        } else if (cmd === 'voices') {
            cmdStr = `${mmxBin} speech voices ${flag}`;
        } else if (cmd === 'vision') {
            cmdStr = `${mmxBin} vision describe --image ${esc(args.image||'')} ${flag}`;
        } else if (cmd === 'quota') {
            cmdStr = `${mmxBin} quota show ${flag}`;
        } else if (cmd === 'video') {
            cmdStr = `${mmxBin} video generate --prompt ${esc(args.prompt||'')} ${flag}`;
        } else {
            return reject(new Error(`Unknown mmx command: ${cmd}`));
        }

        const tmpHome = require('os').tmpdir() + '/mmx_mcp_' + Date.now();
        try { fs.mkdirSync(tmpHome, 0o700); } catch(e) {}

        exec(cmdStr, { env: { ...process.env, HOME: tmpHome }, timeout: 180000, maxBuffer: 10*1024*1024 }, (err, stdout, stderr) => {
            try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(e) {}
            const output = (stdout || '') + (stderr || '');

            if ((cmd === 'speech' || cmd === 'music') && args._outPath && fs.existsSync(args._outPath)) {
                const fn = require('path').basename(args._outPath);
                resolve({ url: `https://naujtrats.xyz/oneapichat/uploads/shared/${fn}`, size: fs.statSync(args._outPath).size });
                return;
            }
            try {
                resolve(JSON.parse(output.trim()));
            } catch(e) {
                resolve({ result: output.trim() });
            }
        });
    });
}

// ── analyze_image → MCP 自带的 Vision 分析 ──
function execAnalyzeImage(args) {
    return new Promise((resolve, reject) => {
        // Accept image_url, image, or url parameter
        const imageUrl = args.image_url || args.image || args.url || '';
        const prompt = args.prompt || args.query || '请详细描述这张图片的内容';
        if (!imageUrl) return reject(new Error('缺少图片参数(image_url/image/url)'));

        const body = JSON.stringify({ image_url: imageUrl, prompt: prompt });
        const opts = {
            hostname: '127.0.0.1', port: 18788, path: '/mcp/analyze',
            method: 'POST', timeout: 120000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        };
        const req = require('http').request(opts, (resp) => {
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    resolve({ result: data.result || data, status: 'ok' });
                } catch(e) { resolve({ result: raw }); }
            });
        });
        req.on('error', (e) => reject(e));
        req.write(body);
        req.end();
    });
}

// ── Engine HTTP proxy ──
function execEngineProxy(ep, args) {
    return new Promise((resolve, reject) => {
        // ★ Cloudreve 云盘代理 → PHP cloudreve_api.php
        if (ep.startsWith('__cr/')) {
            const crAction = ep.replace('__cr/', '');
            let qs = 'action=' + crAction + '&auth_token=cr_shared';
            for (const [k, v] of Object.entries(args)) {
                if (typeof v === 'string' || typeof v === 'number') qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v);
                else if (typeof v === 'object') qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(JSON.stringify(v));
            }
            const crOpts = {
                hostname: '127.0.0.1', port: 443, path: '/oneapichat/api/cloudreve_api.php?' + qs,
                method: 'GET', timeout: 30000,
                headers: { 'Host': 'naujtrats.xyz' },
                rejectUnauthorized: false,
            };
            const crReq = require('https').request(crOpts, (crRes) => {
                let body = '';
                crRes.on('data', (c) => body += c);
                crRes.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch(e) { resolve({ result: body }); }
                });
            });
            crReq.on('error', (e) => reject(e));
            crReq.end();
            return;
        }
        if (ep === '__push_file') {
            const srcPath = (args.path || args.file || '').replace('/oneapichat/', '/var/www/html/oneapichat/');
            if (!fs.existsSync(srcPath)) return reject(new Error('File not found'));
            const shared = '/var/www/html/oneapichat/uploads/shared/';
            if (!fs.existsSync(shared)) fs.mkdirSync(shared, { recursive: true });
            const dest = shared + Date.now() + '_' + require('path').basename(srcPath);
            try { fs.copyFileSync(srcPath, dest); fs.chmodSync(dest, 0o644); resolve({ ok: true, url: 'https://naujtrats.xyz/oneapichat/uploads/shared/' + require('path').basename(dest) }); }
            catch(e) { reject(e); }
            return;
        }

        let qs = 'user_id=u_a418898cebde5e2b1e15d181';
        for (const [k, v] of Object.entries(args)) {
            if (typeof v === 'string' || typeof v === 'number') qs += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
            else if (typeof v === 'object') qs += `&${encodeURIComponent(k)}=${encodeURIComponent(JSON.stringify(v))}`;
        }

        const opts = { hostname: '127.0.0.1', port: 8766, path: `/engine/${ep}?${qs}`, method: 'GET', timeout: 60000 };
        const postBodies = ['file/write', 'file/append', 'file_edit', 'python', 'skills/run', 'video_edit'];
        if (postBodies.includes(ep)) {
            opts.method = 'POST';
            let postBody = '';
            if (ep === 'file_edit') postBody = JSON.stringify({ path: args.path, old_string: args.old_string, new_string: args.new_string });
            else if (ep === 'file/write') postBody = JSON.stringify({ path: args.path, content: args.content, mode: args.mode || 'overwrite' });
            else if (ep === 'python') postBody = args.code || args.script || '';
            else if (ep === 'skills/run') postBody = JSON.stringify({ name: args.name, args });
            else postBody = JSON.stringify(args);
            opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) };
        }

        const mod = http;
        const req = mod.request(opts, resp => {
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ raw }); } });
        });
        req.on('error', e => reject(new Error('Engine error: ' + e.message)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (opts.method === 'POST' && opts.headers) req.write(opts.headers['Content-Length'] ? (postBodies.includes(ep) ? JSON.stringify(args) : args.code || JSON.stringify(args)) : '');
        req.end();
    });
}

// ── Chaoxing QR 登录 ──
const CX_LOGIN_SCRIPT = '/home/naujtrats/mcp-server/chaoxing-login.py';

function execChaoxingQrLogin(args) {
    return new Promise((resolve, reject) => {
        const action = args.action || 'auto';
        let cmdStr, execTimeout;
        if (action === 'check' || action === 'qr' || action === 'auto') {
            // 非阻塞: check/qr/auto 立即返回
            cmdStr = `python3 ${CX_LOGIN_SCRIPT} ${action}`;
            execTimeout = 30000;
        } else {
            // login/poll (阻塞): 优先用传入的 enc/uuid, 过期则返回新QR
            const enc = args.enc || '';
            const uuid = args.uuid || '';
            const timeout = args.timeout || 300;
            cmdStr = `python3 ${CX_LOGIN_SCRIPT} login ${enc} ${uuid} ${timeout}`;
            execTimeout = 360000;
        }

        exec(cmdStr, { timeout: execTimeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && !stdout.trim()) { reject(new Error('Chaoxing login error: ' + err.message)); return; }
            try {
                const result = JSON.parse(stdout.trim());
                resolve(result);
            } catch (e) {
                resolve({ ok: false, error: 'Parse error', raw: (stdout + stderr).trim().substring(0, 300) });
            }
        });
    });
}

// ── web_search ──
function execWebSearch(args) {
    return new Promise(resolve => {
        const q = encodeURIComponent(args.query || '');
        if (!q) return resolve({ results: [], status: 'error', error: 'query required' });
        const timer = setTimeout(() => resolve({ results: [], status: 'timeout' }), 8000);
        https.get(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1`, resp => {
            clearTimeout(timer);
            let raw = '';
            resp.on('data', c => raw += c);
            resp.on('end', () => {
                try {
                    const d = JSON.parse(raw);
                    const results = (d.RelatedTopics || []).slice(0, Math.min(args.max_results || 5, 10))
                        .map(r => ({ title: r.FirstURL || '', url: r.FirstURL || '', content: (r.Text || '').replace(/<[^>]+>/g, '') }));
                    resolve({ results, status: 'ok', provider: 'duckduckgo' });
                } catch(e) { resolve({ results: [], status: 'error' }); }
            });
        }).on('error', e => { clearTimeout(timer); resolve({ results: [], status: 'error', error: e.message }); });
    });
}

// ── web_fetch ──
function execWebFetch(args) {
    const urls = (args.urls || (args.url ? [args.url] : [])).slice(0, 5);
    return Promise.all(urls.map(u => fetchOne(u))).then(arr => {
        const merged = {};
        arr.forEach(r => Object.assign(merged, r));
        return { results: merged, status: 'ok' };
    });
}
function fetchOne(u) {
    return new Promise(resolve => {
        try { new URL(u); } catch { resolve({ [u]: { error: 'Invalid URL' } }); return; }
        const mod = u.startsWith('https') ? https : http;
        const timer = setTimeout(() => resolve({ [u]: { error: 'Timeout' } }), 10000);
        mod.get(u, { timeout: 10000 }, resp => {
            clearTimeout(timer);
            let raw = '';
            resp.on('data', c => { raw += c; if (raw.length > 512000) resp.destroy(); });
            resp.on('end', () => {
                let t = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                t = t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
                if (t.length > 8000) t = t.substring(0, 8000) + '...[truncated]';
                resolve({ [u]: { content: t, length: t.length } });
            });
        }).on('error', e => { clearTimeout(timer); resolve({ [u]: { error: e.message } }); });
    });
}

// ── push_file ──
function execPushFile(args) {
    const srcPath = (args.path || args.file || '').replace('/oneapichat/', '/var/www/html/oneapichat/');
    if (!fs.existsSync(srcPath)) return Promise.reject(new Error('File not found'));
    const shared = '/var/www/html/oneapichat/uploads/shared/';
    if (!fs.existsSync(shared)) fs.mkdirSync(shared, { recursive: true });
    const dest = shared + Date.now() + '_' + require('path').basename(srcPath);
    fs.copyFileSync(srcPath, dest);
    fs.chmodSync(dest, 0o644);
    return Promise.resolve({ ok: true, url: 'https://naujtrats.xyz/oneapichat/uploads/shared/' + require('path').basename(dest) });
}

// ── generate_image ──
function execImageGen(args) {
    return new Promise((resolve, reject) => {
        const prompt = args.prompt || '';
        if (!prompt) return reject(new Error('prompt required'));
        let apiKey = process.env.MMX_API_KEY || '';
        if (!apiKey) {
            try { apiKey = JSON.parse(fs.readFileSync('/var/www/html/oneapichat/config/.mmx_config.json', 'utf8')).api_key || ''; } catch(e) {}
        }
        if (!apiKey) return reject(new Error('MiniMax API key not configured'));
        const mmxBin = '/home/naujtrats/.npm-global/bin/mmx';
        const tmpHome = require('os').tmpdir() + '/mmx_mcp_' + process.pid + '_' + Math.random().toString(36).substring(2, 8);
        try { fs.mkdirSync(tmpHome, 0o700); } catch(e) {}
        exec(`${mmxBin} image generate --prompt "${prompt.replace(/"/g, '\\"')}" --api-key ${apiKey} --region cn --non-interactive --output json 2>&1`,
            { env: { ...process.env, HOME: tmpHome }, timeout: 120000, maxBuffer: 10*1024*1024 },
            (err, stdout, stderr) => {
                try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch(e) {}
                if (err && !stdout.trim()) return reject(new Error('Image gen failed: ' + err.message));
                try {
                    const p = JSON.parse(stdout.trim());
                    resolve({ images: p.urls || [], status: 'ok', provider: 'minimax' });
                } catch(e) { resolve({ error: 'Image gen failed', raw: (stdout + stderr).trim() }); }
            }
        );
    });
}

module.exports = { handleToolList, handleToolCall, getAllTools };
