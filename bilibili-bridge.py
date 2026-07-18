#!/usr/bin/env python3
"""
Bilibili API Bridge — 供 MCP server 调用的 Python 桥接脚本
使用 bilibili-api-python 处理 Wbi 签名、反爬风控
用法: python3 bilibili-bridge.py <command> [args...]
输出: JSON 到 stdout

B站登录配置:
  方式1: 环境变量 BILI_SESSDATA (推荐)
    export BILI_SESSDATA='你的SESSDATA值'
  方式2: 配置文件 /home/naujtrats/mcp-server/.bili_cookie
    第一行放 SESSDATA 值
  获取方法: 浏览器登录 bilibili.com → F12 → Application → Cookies → SESSDATA
"""

import sys, json, asyncio, os
from datetime import datetime
from pathlib import Path

def _load_bili_cookie():
    """加载 B站 Cookie (SESSDATA)"""
    # 方式1: 环境变量
    sessdata = os.environ.get('BILI_SESSDATA', '')
    if sessdata:
        return sessdata

    # 方式2: 配置文件
    cookie_file = Path(__file__).parent / '.bili_cookie'
    if cookie_file.exists():
        try:
            sessdata = cookie_file.read_text().strip().split('\n')[0].strip()
            if sessdata:
                return sessdata
        except:
            pass

    return ''

# 全局单例
_BILI_SESSDATA = _load_bili_cookie()
if _BILI_SESSDATA:
    from bilibili_api import Credential
    _BILI_CREDENTIAL = Credential(sessdata=_BILI_SESSDATA)
else:
    _BILI_CREDENTIAL = None

async def video_info(bvid: str):
    """获取视频详情"""
    from bilibili_api import video, Credential
    # 清理 bvid
    bvid = bvid.strip()
    if 'BV' in bvid:
        import re
        m = re.search(r'BV[a-zA-Z0-9]{10}', bvid)
        if m: bvid = m.group(0)
    elif bvid.lower().startswith('av'):
        bvid = bvid  # AV号直接用
    elif bvid.isdigit():
        bvid = f'av{bvid}'

    v = video.Video(bvid=bvid if bvid.startswith('BV') else None, aid=int(bvid[2:]) if bvid.lower().startswith('av') else None)
    info = await v.get_info()

    # 分P
    try:
        pages = await v.get_pages()
    except:
        pages = []

    return {
        "type": "video",
        "bvid": info.get("bvid", ""),
        "avid": info.get("aid", 0),
        "title": info.get("title", ""),
        "cover": info.get("pic", ""),
        "description": (info.get("desc", "") or "")[:500],
        "author": {
            "name": info.get("owner", {}).get("name", ""),
            "uid": info.get("owner", {}).get("mid", 0),
            "avatar": info.get("owner", {}).get("face", ""),
        },
        "stats": {
            "views": _fmt_count(info.get("stat", {}).get("view")),
            "danmaku": _fmt_count(info.get("stat", {}).get("danmaku")),
            "likes": _fmt_count(info.get("stat", {}).get("like")),
            "coins": _fmt_count(info.get("stat", {}).get("coin")),
            "favorites": _fmt_count(info.get("stat", {}).get("favorite")),
            "shares": _fmt_count(info.get("stat", {}).get("share")),
            "comments": _fmt_count(info.get("stat", {}).get("reply")),
        },
        "duration": _fmt_duration(info.get("duration", 0)),
        "pubdate": datetime.fromtimestamp(info.get("pubdate", 0)).strftime("%Y-%m-%d") if info.get("pubdate") else "",
        "pages": [{"page": p.get("page", 1), "part": p.get("part", ""), "duration": _fmt_duration(p.get("duration", 0))} for p in pages],
        "pages_count": len(pages) or 1,
        "url": f'https://www.bilibili.com/video/{info.get("bvid", "")}',
        "tags": [t.get("tag_name", "") for t in (info.get("tgs") or [])],
    }


async def article_read(cvid: str):
    """阅读专栏文章"""
    import re, aiohttp

    cvid = cvid.strip()
    m = re.search(r'cv(\d+)', cvid, re.I)
    if m: cvid = m.group(1)

    # ★ 先用 bilibili-api 获取元数据
    from bilibili_api import article
    a = article.Article(cvid=int(cvid))
    info = await a.get_info()

    # ★ 用 urllib 获取正文 (aiohttp 被 B站拦截, urllib 正常)
    content = ""
    try:
        import urllib.request
        req = urllib.request.Request(
            f'https://api.bilibili.com/x/article/view?id={int(cvid)}',
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/',
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            art_data = json.loads(resp.read())
            if art_data.get("code") == 0:
                raw_content = art_data.get("data", {}).get("content", "")
                if raw_content:
                    try:
                        delta = json.loads(raw_content)
                        if isinstance(delta, dict) and "ops" in delta:
                            # Quill Delta → 纯文本
                            content = ''.join(
                                op.get("insert", "") if isinstance(op.get("insert"), str)
                                else ""
                                for op in delta.get("ops", [])
                            )
                        else:
                            content = raw_content
                    except (json.JSONDecodeError, TypeError):
                        content = _strip_html(raw_content)
    except Exception as e:
        # fallback
        try:
            content = str(await a.fetch_content())
        except:
            pass

    return {
        "type": "article",
        "id": info.get("id", 0),
        "title": info.get("title", ""),
        "author": {
            "name": info.get("author_name", ""),
            "uid": info.get("mid", 0),
        },
        "summary": (info.get("summary", "") or (content[:200] if content else ""))[:300],
        "content": (content or "")[:10000],
        "stats": {
            "views": _fmt_count(info.get("stats", {}).get("view")),
            "likes": _fmt_count(info.get("stats", {}).get("like")),
            "comments": _fmt_count(info.get("stats", {}).get("reply")),
            "favorites": _fmt_count(info.get("stats", {}).get("favorite")),
        },
        "publish_time": datetime.fromtimestamp(info.get("publish_time", 0)).isoformat() if info.get("publish_time") else "",
        "url": f'https://www.bilibili.com/read/cv{info.get("id", "")}',
        "tags": [t.get("tag_name", t) if isinstance(t, dict) else t for t in (info.get("tags") or [])],
    }


async def user_profile(uid: str):
    """获取用户主页"""
    from bilibili_api import user

    uid = uid.strip()
    u = user.User(uid=int(uid))
    info = await u.get_user_info()

    # 最近投稿
    recent = []
    try:
        videos = await u.get_videos(ps=5)
        for v in (videos.get("list", {}).get("vlist", []) or [])[:5]:
            recent.append({
                "bvid": v.get("bvid", ""),
                "title": v.get("title", ""),
                "views": _fmt_count(v.get("play")),
                "cover": v.get("pic", ""),
                "url": f'https://www.bilibili.com/video/{v.get("bvid", "")}',
            })
    except:
        pass

    return {
        "type": "user_profile",
        "uid": info.get("mid", 0),
        "name": info.get("name", ""),
        "sex": info.get("sex", ""),
        "level": info.get("level", 0),
        "signature": (info.get("sign", "") or "")[:200],
        "avatar": info.get("face", ""),
        "stats": {
            "following": info.get("following", 0),
            "followers": _fmt_count(info.get("follower", 0)),
        },
        "is_vip": bool(info.get("vip", {}).get("status")),
        "videos_count": len(recent),
        "recent_videos": recent,
        "url": f'https://space.bilibili.com/{uid}',
    }


async def search(keyword: str, search_type: str = "video", limit: int = 10):
    """搜索"""
    from bilibili_api import search

    type_map = {"video": search.SearchObjectType.VIDEO, "article": search.SearchObjectType.ARTICLE, "bili_user": search.SearchObjectType.USER}
    st = type_map.get(search_type, search.SearchObjectType.VIDEO)

    result = await search.search_by_type(keyword, search_type=st, page=1, page_size=min(limit, 25))
    items = []
    for r in (result.get("result", []) or [])[:limit]:
        if search_type == "bili_user":
            items.append({
                "type": "user", "uid": r.get("mid", 0), "name": r.get("uname", ""),
                "signature": (r.get("usign", "") or "")[:200],
                "followers": _fmt_count(r.get("fans")),
                "videos_count": r.get("videos", 0),
                "avatar": r.get("upic", ""),
                "url": f'https://space.bilibili.com/{r.get("mid", 0)}',
            })
        elif search_type == "article":
            items.append({
                "type": "article", "id": r.get("id", 0),
                "title": _strip_html(r.get("title", "")),
                "author": r.get("author", ""),
                "summary": (_strip_html(r.get("description", "")) or "")[:200],
                "views": _fmt_count(r.get("play")),
                "url": f'https://www.bilibili.com/read/cv{r.get("id", 0)}',
            })
        else:
            items.append({
                "type": "video", "bvid": r.get("bvid", ""), "avid": r.get("aid", 0),
                "title": _strip_html(r.get("title", "")),
                "author": r.get("author", ""),
                "description": (_strip_html(r.get("description", "")) or "")[:200],
                "cover": r.get("pic", ""),
                "duration": r.get("duration", ""),
                "views": _fmt_count(r.get("play")),
                "danmaku": _fmt_count(r.get("video_review")),
                "pubdate": datetime.fromtimestamp(r.get("pubdate", 0)).strftime("%Y-%m-%d") if r.get("pubdate") else "",
                "url": f'https://www.bilibili.com/video/{r.get("bvid", "")}',
                "tags": (r.get("tag", "") or "").split(",") if r.get("tag") else [],
            })

    return {
        "type": "search", "keyword": keyword,
        "search_type": search_type, "count": len(items),
        "total": result.get("numResults", 0),
        "results": items,
    }


async def dynamic_list(uid: str, limit: int = 10):
    """获取用户动态 (优先使用 Cookie 登录, 否则尝试公开 API)
    注意: B站对动态接口有较强反爬, 未登录时可能被风控。
    配置 Cookie 方法: 浏览器登录 bilibili.com → F12 → Application → Cookies → 复制 SESSDATA 值
    然后: echo '你的SESSDATA' > /home/naujtrats/mcp-server/.bili_cookie
    """
    import aiohttp

    uid = uid.strip()
    sessdata = _BILI_SESSDATA

    # 有 Cookie → 用登录态 API (获取关注+推荐动态流)
    if sessdata and _BILI_CREDENTIAL:
        try:
            from bilibili_api import dynamic
            # ★ B站 API: host_mid 仅限已关注用户; 不传 host_mid 获取关注+推荐流
            resp = await dynamic.get_dynamic_page_info(
                credential=_BILI_CREDENTIAL,
                pn=1,
            )
        except Exception as e:
            return {"type": "dynamic_list", "uid": uid, "count": 0, "error": str(e), "items": []}

        items = []
        cards = resp.get("items", []) or []
        for card in cards[:limit]:
            modules = card.get("modules", {}) if isinstance(card, dict) else {}
            mod_dyn = modules.get("module_dynamic", {}) or {}
            desc = mod_dyn.get("desc") or {}
            major = mod_dyn.get("major") or {}
            author = modules.get("module_author", {}) or {}
            stat = modules.get("module_stat", {}) or {}

            # ★ 从 major 中提取内容和媒体
            content = ""
            media_urls = []
            ctype = "text"

            if major.get("opus"):
                opus = major["opus"]
                content = opus.get("title", "") + "\n" + (opus.get("summary", {}).get("text", "") if isinstance(opus.get("summary"), dict) else "")
                ctype = "post"
            elif major.get("archive"):
                arch = major["archive"]
                content, ctype = arch.get("title", ""), "video"
                media_urls = [arch.get("cover", "")]
            elif major.get("draw"):
                draw = major["draw"]
                ctype = "image"
                media_urls = [i.get("src", "") for i in (draw.get("items", []) or [])[:4]]
                content = (desc.get("text", "") if desc else "") or ""
            elif major.get("article"):
                art = major["article"]
                content, ctype = art.get("title", ""), "article"
                media_urls = art.get("covers", []) or []
            elif major.get("common"):
                common = major["common"]
                content = common.get("title", "") or common.get("desc", "") or ""
                ctype = "share"
            elif desc:
                content = desc.get("text", "") if isinstance(desc, dict) else str(desc)

            # 如果 desc 有文本但 content 为空, 用 desc.text
            if not content and desc and isinstance(desc, dict):
                content = desc.get("text", "") or ""

            items.append({
                "id": card.get("id_str", card.get("id", "")),
                "type": ctype,
                "content": _strip_html(content)[:500],
                "author": {"name": author.get("name", ""), "uid": author.get("mid", 0), "avatar": author.get("face", "")},
                "media_urls": media_urls[:4],
                "stats": {
                    "likes": _fmt_count(stat.get("like", {}).get("count", 0) if isinstance(stat.get("like"), dict) else stat.get("like", 0)),
                    "comments": _fmt_count(stat.get("comment", {}).get("count", 0) if isinstance(stat.get("comment"), dict) else stat.get("comment", 0)),
                    "reposts": _fmt_count(stat.get("forward", {}).get("count", 0) if isinstance(stat.get("forward"), dict) else stat.get("forward", 0)),
                },
                "time": author.get("pub_time", ""),
                "url": f'https://t.bilibili.com/{card.get("id_str", card.get("id", ""))}',
            })

        return {"type": "dynamic_list", "uid": uid, "count": len(items), "items": items, "authenticated": True, "source": "B站关注+推荐动态流"}

    # 无 Cookie → 尝试公开 API (大概率被风控)
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': f'https://space.bilibili.com/{uid}/dynamic',
            'Accept': 'application/json, text/plain, */*',
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
                params={'host_mid': uid, 'offset': '', 'features': 'itemOpusStyle'},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json()
    except Exception as e:
        return {"type": "dynamic_list", "uid": uid, "count": 0, "error": str(e), "items": [],
                "hint": "动态接口被B站风控。请登录B站获取SESSDATA: 浏览器打开bilibili.com → F12 → Application → Cookies → 复制SESSDATA → 执行 echo '你的SESSDATA' > /home/naujtrats/mcp-server/.bili_cookie"}

    if data.get("code") != 0:
        return {"type": "dynamic_list", "uid": uid, "count": 0, "error": data.get("message", "API error"), "items": [],
                "hint": "配置B站Cookie后可正常使用: echo '你的SESSDATA' > /home/naujtrats/mcp-server/.bili_cookie"}

    raw_items = data.get("data", {}).get("items", []) or []
    items = []
    for card in raw_items[:limit]:
        # 解析动态卡片
        modules = card.get("modules", {}) if isinstance(card, dict) else {}
        desc = modules.get("module_dynamic", {}).get("desc", {})
        major = modules.get("module_dynamic", {}).get("major", {})
        author = modules.get("module_author", {})
        stat = modules.get("module_stat", {})

        content = (desc.get("text", "") or "")[:500]
        media_urls = []
        ctype = "text"

        if major.get("archive"):
            ctype = "video"
            archive = major["archive"]
            content = f'[视频] {archive.get("title", "")}'
            media_urls = [archive.get("cover", "")]
        elif major.get("article"):
            ctype = "article"
            article = major["article"]
            content = f'[专栏] {article.get("title", "")}'
            media_urls = article.get("covers", [])
        elif major.get("draw"):
            ctype = "image"
            media_urls = [i.get("src", "") for i in (major["draw"].get("items", []) or [])[:4]]
        elif major.get("opus"):
            ctype = "post"

        items.append({
            "id": card.get("id_str", card.get("id", "")),
            "type": ctype,
            "content": _strip_html(content)[:500],
            "author": {"name": author.get("name", ""), "uid": author.get("mid", 0), "avatar": author.get("face", "")},
            "media_urls": media_urls[:4],
            "stats": {
                "likes": _fmt_count(stat.get("like", {}).get("count", 0)),
                "comments": _fmt_count(stat.get("comment", {}).get("count", 0)),
                "reposts": _fmt_count(stat.get("forward", {}).get("count", 0)),
            },
            "time": author.get("pub_time", ""),
            "url": f'https://t.bilibili.com/{card.get("id_str", card.get("id", ""))}',
        })

    return {
        "type": "dynamic_list", "uid": uid,
        "count": len(items), "items": items,
    }


async def comment_list(oid: str, ctype: int = 1, limit: int = 20):
    """获取评论 (使用 Web 公开 API)"""
    import aiohttp
    from bilibili_api import video
    import re as _re

    oid = oid.strip()
    actual_oid = oid

    # 视频 BV号 → avid
    if ctype == 1 and _re.match(r'BV', oid, re.I):
        try:
            v = video.Video(bvid=oid)
            info = await v.get_info()
            actual_oid = info.get("aid", oid)
        except:
            pass
    elif ctype == 12:
        m = _re.search(r'cv(\d+)', oid, re.I)
        if m: actual_oid = m.group(1)

    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.bilibili.com/',
        }
        async with aiohttp.ClientSession() as session:
            async with session.get(
                'https://api.bilibili.com/x/v2/reply',
                params={'type': ctype, 'oid': actual_oid, 'ps': limit, 'sort': 1},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json()
    except Exception as e:
        return {"type": "comments", "oid": oid, "count": 0, "error": str(e), "comments": []}

    if data.get("code") != 0:
        return {"type": "comments", "oid": oid, "count": 0, "error": data.get("message", "API error"), "comments": []}

    replies = data.get("data", {})
    comments = []
    for r in (replies.get("replies", []) or [])[:limit]:
        comments.append({
            "id": r.get("rpid", 0),
            "user": {"name": r.get("member", {}).get("uname", ""), "uid": r.get("member", {}).get("mid", 0)},
            "content": (r.get("content", {}).get("message", "") or "")[:300],
            "likes": r.get("like", 0),
            "replies_count": r.get("rcount", 0),
            "time": datetime.fromtimestamp(r.get("ctime", 0)).isoformat() if r.get("ctime") else "",
            "sub_replies": [
                {"user": {"name": s.get("member", {}).get("uname", ""), "uid": s.get("member", {}).get("mid", 0)},
                 "content": (s.get("content", {}).get("message", "") or "")[:200],
                 "likes": s.get("like", 0)}
                for s in (r.get("replies", []) or [])[:3]
            ],
        })

    return {
        "type": "comments", "oid": oid,
        "comment_type": {1: "视频", 12: "专栏", 17: "动态"}.get(ctype, "其他"),
        "count": len(comments),
        "total": replies.get("page", {}).get("acount", 0),
        "comments": comments,
    }


# ═══════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════

def _fmt_count(num):
    if not num: return "0"
    num = int(num)
    if num >= 100000000: return f"{num/100000000:.1f}亿"
    if num >= 10000: return f"{num/10000:.1f}万"
    return str(num)

def _fmt_duration(seconds):
    if not seconds: return "00:00"
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h > 0 else f"{m:02d}:{sec:02d}"

def _strip_html(text):
    import re
    return re.sub(r'<[^>]+>', '', str(text))

# ═══════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════

COMMANDS = {
    "video_info": (video_info, ["bvid"]),
    "article_read": (article_read, ["cvid"]),
    "user_profile": (user_profile, ["uid"]),
    "search": (search, ["keyword", "search_type", "limit"]),
    "dynamic_list": (dynamic_list, ["uid", "limit"]),
    "comment_list": (comment_list, ["oid", "ctype", "limit"]),
}

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command", "available": list(COMMANDS.keys())}))
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(json.dumps({"error": f"Unknown command: {cmd}", "available": list(COMMANDS.keys())}))
        sys.exit(1)

    handler, arg_names = COMMANDS[cmd]
    kwargs = {}
    for i, name in enumerate(arg_names):
        if i + 2 < len(sys.argv):
            val = sys.argv[i + 2]
            if name == "limit": val = int(val)
            if name == "type": val = int(val)
            kwargs[name] = val

    try:
        result = await handler(**kwargs)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "command": cmd}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
