# OneAPIChat MCP Server

**Node.js MCP 工具服务 — OneAPIChat 的 69 工具统一后端**

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

---

## 架构

```
PHP API (tools/call.php)
    │
    ▼
MCP Server (:18788)          ← 此仓库
    │
    ├── Node.js handlers (web_search, web_fetch, generate_image)
    ├── Python bridge (bilibili_*, chaoxing_*)
    ├── MiniMax CLI (mmx_*)
    └── Engine proxy → Python FastAPI (:8766)
```

## 工具清单 (69 tools)

| 分类 | 数量 | 示例 |
|------|:--:|------|
| 搜索 | 3 | web_search, web_fetch, platform_extract |
| 图像 | 3 | generate_image, analyze_image |
| B站 | 7 | bilibili_search, bilibili_video_info, bilibili_qr_login |
| 办公文档 | 4 | generate_ppt, generate_docx, generate_xlsx, generate_pdf |
| 视频 | 2 | video_understanding, video_edit |
| 超星学习通 | 1+ | chaoxing_qr_login |
| Cloudreve | 14 | cr_list_files, cr_search_files 等 |
| 服务器 | 15 | server_exec, server_file_read 等 |
| 浏览器 | 6 | browser_navigate 等 |
| MiniMax | 8 | mmx_chat, mmx_image 等 |
| Agent | 5 | delegate_task, plan_update 等 |

## 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/mcp/api/tools` | POST | 全部工具列表 (MCP inputSchema) |
| `/mcp/api/tools/call` | POST | 通用工具执行 |
| `/mcp/bilibili/tools` | POST | B站工具列表 |
| `/mcp/bilibili/tools/call` | POST | B站工具执行 |
| `/mcp/analyze` | POST | 图片/视频分析 (MiniMax Vision) |
| `/mcp/health` | GET | 健康检查 |

## 运行

```bash
node server.js
# 监听 127.0.0.1:18788
```

## 新增工具

在 `api-tools.js` 的 `EXTRA_TOOLS` 数组中添加工具定义，在 `ENGINE_MAP` 或 `execTool()` 中添加执行路由。

## License

GPL-3.0
