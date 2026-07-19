#!/usr/bin/env python3
"""
Bilibili QR Code Login — 扫码登录获取 SESSDATA
直接调用 B站 REST API (无需 bilibili_api.login 模块)

用法:
  python3 bilibili-login.py check          检查当前 cookie 是否有效
  python3 bilibili-login.py qr             生成登录二维码
  python3 bilibili-login.py poll <key>     检测扫码状态
  python3 bilibili-login.py auto [timeout] 一键自动登录

工作原理:
  1. qr  → 调用 B站 API 获取二维码 URL + qrcode_key
  2. qr  → 用 qrcode 库生成 PNG 保存到 uploads/shared/
  3. poll → 轮询 B站 API 检测用户是否扫码+确认
  4. 成功后自动保存 SESSDATA 到 .bili_cookie
"""

import sys, json, asyncio, os, time, io, base64
from pathlib import Path
from PIL import Image as PILImage, ImageFilter, ImageDraw, ImageFont

COOKIE_FILE = Path(__file__).parent / '.bili_cookie'
# 两个路径: 1) base64内联(聊天窗口直接显示) 2) 公网URL(外部访问)
QR_DIR = Path(__file__).parent  # mcp-server 目录
QR_PUBLIC_DIR = Path('/var/www/html/oneapichat')  # nginx: /oneapichat/ → /var/www/html/oneapichat/
QR_PUBLIC_URL = 'https://naujtrats.xyz/oneapichat'

import aiohttp

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
}

# ═══════════════════════════════════════════════════
# Cookie 有效性检查
# ═══════════════════════════════════════════════════

async def check_cookie():
    if not COOKIE_FILE.exists():
        return {"valid": False, "reason": "no_cookie_file", "need_login": True}

    sessdata = COOKIE_FILE.read_text().strip().split('\n')[0].strip()
    if not sessdata:
        return {"valid": False, "reason": "empty_cookie", "need_login": True}

    try:
        from bilibili_api import Credential, user
        cred = Credential(sessdata=sessdata)
        info = await user.get_self_info(credential=cred)
        return {
            "valid": True,
            "uid": info.get("mid", 0),
            "name": info.get("name", ""),
            "level": info.get("level", 0),
            "need_login": False,
        }
    except Exception as e:
        return {"valid": False, "reason": str(e)[:100], "need_login": True}

# ═══════════════════════════════════════════════════
# 生成二维码
# ═══════════════════════════════════════════════════

async def generate_qrcode():
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
                headers=HEADERS,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                data = await resp.json()
    except Exception as e:
        return {"ok": False, "error": f"获取二维码失败: {e}"}

    if data.get("code") != 0:
        return {"ok": False, "error": data.get("message", "API error")}

    qr_data = data.get("data", {})
    qr_url = qr_data.get("url", "")
    qrcode_key = qr_data.get("qrcode_key", "")

    if not qr_url or not qrcode_key:
        return {"ok": False, "error": "API返回数据异常"}

    # 生成二维码图片
    try:
        import qrcode as qr_module
        qr = qr_module.QRCode(box_size=10, border=2)
        qr.add_data(qr_url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")

        # 保存到本地
        img_path = QR_DIR / f'bilibili_qr_{qrcode_key[:8]}.png'
        img.save(str(img_path))

        # ★ 保存到 public 目录 (公网可访问)，需要 sudo
        public_path = QR_PUBLIC_DIR / 'bilibili_qr.png'
        try:
            img.save(str(public_path))
            os.system(f'sudo chmod 644 {public_path} 2>/dev/null')
        except PermissionError:
            try:
                os.system(f'sudo cp {img_path} {public_path} && sudo chmod 644 {public_path}')
            except:
                pass

        # ★ base64 内联图片 (模型可直接发给用户, 聊天框内显示)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        image_base64 = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

        # 公网 URL (加时间戳防缓存)
        img_url = f'{QR_PUBLIC_URL}/bilibili_qr.png?t={int(time.time())}'
    except Exception as e:
        return {"ok": False, "error": f"生成二维码图片失败: {e}", "qr_url": qr_url, "qrcode_key": qrcode_key}

    return {
        "ok": True,
        "qrcode_key": qrcode_key,
        "qr_image_url": img_url,           # https://naujtrats.xyz/oneapichat/bilibili_qr.png
        "qr_image_base64": image_base64,    # data:image/png;base64,... → 聊天框直接显示
        "qr_image_path": str(img_path),
        "expires_in": 180,
        "scan_url": qr_url,
    }

# ═══════════════════════════════════════════════════
# 成功反馈图: 模糊QR + 绿色勾
# ═══════════════════════════════════════════════════

def make_success_image():
    """生成登录成功的反馈图: 模糊当前QR + 绿色对勾"""
    qr_path = QR_PUBLIC_DIR / 'bilibili_qr.png'
    local_qr = QR_DIR / 'bilibili_qr_current.png'

    # 找最近的QR图
    img_src = None
    if qr_path.exists():
        img_src = qr_path
    elif local_qr.exists():
        img_src = local_qr
    else:
        # 找任意 bilibili_qr_*.png
        for f in sorted(QR_DIR.glob('bilibili_qr_*.png'), key=os.path.getmtime, reverse=True):
            img_src = f; break

    if not img_src:
        return None

    try:
        img = PILImage.open(str(img_src)).convert('RGBA')
        w, h = img.size

        # 1. 高斯模糊
        blurred = img.filter(ImageFilter.GaussianBlur(radius=12))

        # 2. 半透明暗色遮罩
        overlay = PILImage.new('RGBA', (w, h), (0, 0, 0, 120))
        blurred = PILImage.alpha_composite(blurred, overlay)

        # 3. 绿色圆形背景 + 白色对勾
        draw = ImageDraw.Draw(blurred)
        cx, cy = w // 2, h // 2
        r = min(w, h) // 5

        # 绿圆
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(76, 175, 80, 255))

        # 白色对勾 (用粗线画三笔)
        import math
        lw = max(r // 4, 3)
        pts = [
            (cx - r * 0.45, cy),
            (cx - r * 0.1, cy + r * 0.35),
            (cx + r * 0.4, cy - r * 0.3),
        ]
        draw.line(pts[:2], fill='white', width=lw)
        draw.line(pts[1:], fill='white', width=lw)

        buf = io.BytesIO()
        blurred.save(buf, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None

# ═══════════════════════════════════════════════════
# 轮询扫码状态
# ═══════════════════════════════════════════════════

async def poll_login(qrcode_key: str, max_wait: int = 120):
    """轮询扫码状态, 自动刷新过期QR, 直到成功或超时"""
    if not qrcode_key:
        return {"ok": False, "error": "缺少 qrcode_key"}

    start = time.time()
    current_key = qrcode_key
    qr_base64 = None
    qr_url = None

    while time.time() - start < max_wait:
        await asyncio.sleep(2)  # 每2秒检查一次

        try:
            async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar()) as session:
                async with session.get(
                    'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
                    params={'qrcode_key': current_key},
                    headers={**HEADERS, 'Origin': 'https://www.bilibili.com'},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    data = await resp.json()
                    cookies = {c.key: c.value for c in session.cookie_jar}
        except Exception as e:
            continue

        code = data.get("data", {}).get("code", data.get("code", -1))

        if code == 0:
            sessdata = cookies.get("SESSDATA", "")
            if not sessdata:
                return {"ok": False, "error": "登录成功但未获取到 SESSDATA cookie"}
            COOKIE_FILE.write_text(sessdata + '\n')
            COOKIE_FILE.chmod(0o600)
            success_image = make_success_image()
            from bilibili_api import Credential, user
            try:
                cred = Credential(sessdata=sessdata)
                info = await user.get_self_info(credential=cred)
                return {"ok": True, "status": "logged_in", "uid": info.get("mid", 0),
                        "name": info.get("name", ""), "level": info.get("level", 0),
                        "sessdata_saved": True, "success_image": success_image}
            except:
                return {"ok": True, "status": "logged_in", "sessdata_saved": True,
                        "success_image": success_image, "note": "Cookie已保存"}

        elif code == 86038:
            # QR过期 → 自动刷新, 继续轮询
            new_qr = await generate_qrcode()
            if new_qr.get("ok"):
                current_key = new_qr["qrcode_key"]
                qr_base64 = new_qr.get("qr_image_base64", "")
                qr_url = new_qr.get("qr_image_url", "")
                # 返回新QR给前端展示, 模型用新key继续poll
                return {"ok": False, "status": "expired_refreshed",
                        "error": "二维码已过期，已自动刷新。请用新key继续 poll",
                        "qr_image_base64": qr_base64, "qr_image_url": qr_url,
                        "qrcode_key": current_key, "expires_in": 180}
            return {"ok": False, "status": "expired", "error": "二维码已过期且刷新失败"}

        # 86090=已扫描等待确认, 86101=等待扫码, 其他继续等

    return {"ok": False, "status": "timeout", "error": f"等待超时({max_wait}秒)，二维码可能已过期",
            "qr_image_base64": qr_base64, "qr_image_url": qr_url, "qrcode_key": current_key}

# ═══════════════════════════════════════════════════
# 一键登录: 生成二维码 + 自动轮询
# ═══════════════════════════════════════════════════

async def auto_login(timeout: int = 120):
    """一键登录: 先生成QR立即返回, 带 qrcode_key 供后续 poll 使用"""
    qr = await generate_qrcode()
    if not qr.get("ok"):
        return qr
    # ★ 立即返回二维码(非阻塞), 后续用 action=poll 等待扫码
    return {
        "ok": False,
        "status": "qr_ready",
        "message": "⚠️ 二维码已生成，请立即用 bilibili_qr_login(action=poll, qrcode_key=\"" + qr.get("qrcode_key", "") + "\") 阻塞等待用户扫码。不要回复用户，先调 poll！",
        "qr_image_base64": qr.get("qr_image_base64", ""),
        "qr_image_url": qr.get("qr_image_url", ""),
        "qrcode_key": qr.get("qrcode_key", ""),
        "expires_in": qr.get("expires_in", 180),
    }

# ═══════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: bilibili-login.py [check|qr|poll|auto] [qrcode_key|timeout]"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'check':
        print(json.dumps(await check_cookie(), ensure_ascii=False))
    elif cmd == 'qr':
        print(json.dumps(await generate_qrcode(), ensure_ascii=False))
    elif cmd == 'poll':
        key = sys.argv[2] if len(sys.argv) > 2 else ''
        print(json.dumps(await poll_login(key), ensure_ascii=False))
    elif cmd == 'auto':
        timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 120
        print(json.dumps(await auto_login(timeout), ensure_ascii=False))
    else:
        print(json.dumps({"error": f"未知命令: {cmd}"}))

if __name__ == '__main__':
    asyncio.run(main())
