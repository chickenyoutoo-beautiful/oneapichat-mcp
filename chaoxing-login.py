#!/usr/bin/env python3
"""
Chaoxing QR Code Login — 扫码登录获取 Cookie
直接调用超星 REST API (无需第三方库)

用法:
  python3 chaoxing-login.py check          检查当前 cookie 是否有效
  python3 chaoxing-login.py qr             生成登录二维码
  python3 chaoxing-login.py poll <enc> <uuid>  检测扫码状态
  python3 chaoxing-login.py auto [timeout] 一键自动登录

工作原理:
  1. 加载 passport2.chaoxing.com/login → 解析 uuid + enc
  2. GET /createqr?uuid=...&fid=-1 → 下载二维码 PNG
  3. POST /getauthstatus/v2 → 轮询检测用户是否扫码+确认
  4. 成功后自动保存 Cookie 到 .cx_cookie
"""

import sys, json, asyncio, os, time, io, base64, re, pickle
from pathlib import Path
from http.cookiejar import CookieJar as HTTPCookieJar

COOKIE_FILE = Path(__file__).parent / '.cx_cookie'
QR_DIR = Path(__file__).parent  # mcp-server 目录
QR_PUBLIC_DIR = Path('/var/www/html/oneapichat')
QR_PUBLIC_URL = 'https://naujtrats.xyz/oneapichat'

import aiohttp

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

PASSPORT_BASE = 'https://passport2.chaoxing.com'

# ═══════════════════════════════════════════════════
# Cookie 管理
# ═══════════════════════════════════════════════════

def save_cookies_from_jar(cookie_jar):
    """保存 aiohttp CookieJar 中的 cookie 到文件 (requests pickle 格式兼容)"""
    cookies_to_save = []
    for cookie in cookie_jar:
        # aiohttp cookie jar iterates over (morsel, key) - actually it's simpler
        pass
    # aiohttp CookieJar 遍历
    from requests.cookies import RequestsCookieJar
    rj = RequestsCookieJar()
    # aiohttp's CookieJar stores SimpleCookie objects
    for host_cookies in cookie_jar._cookies.values():
        for path_cookies in host_cookies.values():
            for name, cookie in path_cookies.items():
                rj.set(
                    name=name,
                    value=cookie.value,
                    domain=cookie.get('domain', ''),
                    path=cookie.get('path', '/'),
                    secure=cookie.get('secure', False),
                    expires=cookie.get('expires', None),
                )
    # Also save raw key-value for the existing chaoxing code which only needs basic cookies
    raw_cookies = []
    for host_cookies in cookie_jar._cookies.values():
        for path_cookies in host_cookies.values():
            for name, cookie in path_cookies.items():
                raw_cookies.append(f"{name}={cookie.value}")

    cookie_str = '; '.join(raw_cookies)
    COOKIE_FILE.write_text(cookie_str, encoding='utf-8')
    COOKIE_FILE.chmod(0o600)


def make_success_image():
    """生成登录成功的反馈图: 模糊当前QR + 绿色对勾"""
    try:
        from PIL import Image as PILImage, ImageFilter, ImageDraw
    except ImportError:
        return None

    qr_path = QR_PUBLIC_DIR / 'chaoxing_qr.png'
    if not qr_path.exists():
        return None

    try:
        img = PILImage.open(str(qr_path)).convert('RGBA')
        w, h = img.size

        # 高斯模糊
        blurred = img.filter(ImageFilter.GaussianBlur(radius=12))

        # 半透明暗色遮罩
        overlay = PILImage.new('RGBA', (w, h), (0, 0, 0, 120))
        blurred = PILImage.alpha_composite(blurred, overlay)

        # 绿色圆形 + 白色对勾
        draw = ImageDraw.Draw(blurred)
        cx, cy = w // 2, h // 2
        r = min(w, h) // 5

        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(76, 175, 80, 255))

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
# Cookie 有效性检查
# ═══════════════════════════════════════════════════

async def check_cookie():
    if not COOKIE_FILE.exists():
        return {"valid": False, "reason": "no_cookie_file", "need_login": True}

    cookie_str = COOKIE_FILE.read_text().strip()
    if not cookie_str:
        return {"valid": False, "reason": "empty_cookie", "need_login": True}

    try:
        # Test by fetching user info
        headers = {**HEADERS, 'Cookie': cookie_str}
        async with aiohttp.ClientSession() as session:
            async with session.get(
                'https://i.mooc.chaoxing.com/space/index',
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
                allow_redirects=False,
            ) as resp:
                # If logged in, should redirect or return 200 with user content
                # If not logged in, redirects to passport2 login page
                location = resp.headers.get('Location', '')
                if 'passport2' in location or 'login' in location:
                    return {"valid": False, "reason": "cookie_expired", "need_login": True}
                else:
                    return {"valid": True, "need_login": False}
    except Exception as e:
        return {"valid": False, "reason": str(e)[:100], "need_login": True}


# ═══════════════════════════════════════════════════
# 生成二维码
# ═══════════════════════════════════════════════════

async def generate_qrcode():
    """获取 uuid+enc 并下载二维码图片"""
    try:
        # Step 1: 加载登录页获取 uuid 和 enc
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f'{PASSPORT_BASE}/login',
                headers=HEADERS,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                html = await resp.text()

        # 解析 hidden inputs (value 和 id 顺序不确定)
        uuid_match = re.search(r'<input[^>]*id="uuid"[^>]*value="([^"]*)"', html) or \
                     re.search(r'<input[^>]*value="([^"]*)"[^>]*id="uuid"', html)
        enc_match = re.search(r'<input[^>]*id="enc"[^>]*value="([^"]*)"', html) or \
                    re.search(r'<input[^>]*value="([^"]*)"[^>]*id="enc"', html)

        if not uuid_match or not enc_match:
            return {"ok": False, "error": "无法从登录页解析 uuid/enc"}

        uuid = uuid_match.group(1)
        enc = enc_match.group(1)

        if not uuid or not enc:
            return {"ok": False, "error": "uuid 或 enc 为空"}

        # Step 2: 下载二维码图片
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f'{PASSPORT_BASE}/createqr',
                params={'uuid': uuid, 'fid': '-1'},
                headers=HEADERS,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                img_data = await resp.read()

        if not img_data or len(img_data) < 100:
            return {"ok": False, "error": "二维码图片下载失败或为空"}

        # Step 3: 保存图片
        local_path = QR_DIR / f'chaoxing_qr_{uuid[:8]}.png'
        local_path.write_bytes(img_data)

        public_path = QR_PUBLIC_DIR / 'chaoxing_qr.png'
        try:
            public_path.write_bytes(img_data)
            os.system(f'sudo chmod 644 {public_path} 2>/dev/null')
        except PermissionError:
            try:
                os.system(f'sudo cp {local_path} {public_path} && sudo chmod 644 {public_path}')
            except:
                pass

        # base64 内联
        image_base64 = 'data:image/png;base64,' + base64.b64encode(img_data).decode()

        img_url = f'{QR_PUBLIC_URL}/chaoxing_qr.png?t={int(time.time())}'

    except Exception as e:
        return {"ok": False, "error": f"生成二维码失败: {e}"}

    return {
        "ok": True,
        "uuid": uuid,
        "enc": enc,
        "qr_image_url": img_url,
        "qr_image_base64": image_base64,
        "qr_image_path": str(local_path),
        "expires_in": 120,
    }


# ═══════════════════════════════════════════════════
# 内部辅助: 在已有 session 中生成新鲜 QR (加载登录页 + 下载PNG)
# ═══════════════════════════════════════════════════

async def _fresh_qr(session):
    """在已有 session 中加载登录页获取新 enc/uuid 并下载 QR"""
    try:
        async with session.get(
            f'{PASSPORT_BASE}/login',
            headers=HEADERS,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            html = await resp.text()

        uuid_m = re.search(r'<input[^>]*id="uuid"[^>]*value="([^"]*)"', html) or \
                 re.search(r'<input[^>]*value="([^"]*)"[^>]*id="uuid"', html)
        enc_m = re.search(r'<input[^>]*id="enc"[^>]*value="([^"]*)"', html) or \
                re.search(r'<input[^>]*value="([^"]*)"[^>]*id="enc"', html)

        if not uuid_m or not enc_m:
            return None

        new_uuid = uuid_m.group(1)
        new_enc = enc_m.group(1)

        # 下载 QR
        async with session.get(
            f'{PASSPORT_BASE}/createqr',
            params={'uuid': new_uuid, 'fid': '-1'},
            headers={**HEADERS, 'Accept': 'image/png, */*'},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as qr_resp:
            img_data = await qr_resp.read()

        if not img_data or len(img_data) < 100:
            return None

        # 保存图片
        local_path = QR_DIR / f'chaoxing_qr_{new_uuid[:8]}.png'
        local_path.write_bytes(img_data)
        public_path = QR_PUBLIC_DIR / 'chaoxing_qr.png'
        try:
            public_path.write_bytes(img_data)
            os.system(f'sudo chmod 644 {public_path} 2>/dev/null')
        except:
            pass

        return {
            'enc': new_enc,
            'uuid': new_uuid,
            'qr_image_base64': 'data:image/png;base64,' + base64.b64encode(img_data).decode(),
            'qr_image_url': f'{QR_PUBLIC_URL}/chaoxing_qr.png?t={int(time.time())}',
        }
    except Exception:
        return None


# ═══════════════════════════════════════════════════
# 一键登录: 生成QR → 轮询(内部自动刷新) → 返回结果
# ═══════════════════════════════════════════════════

async def login_action(enc: str = '', uuid: str = '', max_wait: int = 300):
    """
    扫码登录轮询 — 优先使用传入的 enc/uuid (来自 auto/qr 步骤),
    如果过期则刷新并返回 expired_refreshed (让用户看到新QR),
    用户扫码确认 → 返回 logged_in, 超时 → 返回 timeout
    """
    start = time.time()
    poll_count = 0
    qr_refresh_count = 0

    async with aiohttp.ClientSession() as session:
        # ★ 加载登录页获取 JSESSIONID
        try:
            async with session.get(
                f'{PASSPORT_BASE}/login',
                headers=HEADERS,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                await resp.text()
        except Exception:
            pass

        # ★ 优先使用传入的 enc/uuid (与 auto/qr 步骤生成的QR一致)
        current_enc = enc
        current_uuid = uuid
        if not current_enc or not current_uuid:
            # 如果没有传入, 生成新鲜 QR 并立即返回 (让前端显示)
            qr = await _fresh_qr(session)
            if not qr:
                return {"ok": False, "error": "无法获取登录二维码"}
            # 返回 QR 让前端显示, 模型再调 login 时带 enc/uuid
            return {
                "ok": False,
                "status": "expired_refreshed",
                "error": "二维码已生成，请立即用新的 enc+uuid 继续 login",
                "qr_image_base64": qr['qr_image_base64'],
                "qr_image_url": qr['qr_image_url'],
                "enc": qr['enc'],
                "uuid": qr['uuid'],
                "expires_in": 60,
            }

        while time.time() - start < max_wait:
            await asyncio.sleep(2)
            poll_count += 1

            try:
                form_data = {
                    'enc': current_enc,
                    'uuid': current_uuid,
                    'doubleFactorLogin': '0',
                    'forbidotherlogin': '0',
                }
                async with session.post(
                    f'{PASSPORT_BASE}/getauthstatus/v2',
                    data=form_data,
                    headers={
                        **HEADERS,
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': f'{PASSPORT_BASE}/login',
                        'Origin': PASSPORT_BASE,
                    },
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    raw_text = await resp.text()
                    data = json.loads(raw_text)
            except Exception:
                continue

            status = data.get('status', False)

            if status:
                # ★ 登录成功 — 保存 cookies (先尝试从 session, 再跟随重定向获取)
                cookie_str = ''
                for host_cookies in session.cookie_jar._cookies.values():
                    for path_cookies in host_cookies.values():
                        for name, cookie in path_cookies.items():
                            val = cookie.value if hasattr(cookie, 'value') else cookie
                            cookie_str += f"{name}={val}; "

                # ★ 如果 session cookie 为空, 跟随重定向获取 auth cookie
                if not cookie_str:
                    try:
                        async with session.get(
                            'https://i.mooc.chaoxing.com/space/index',
                            headers=HEADERS,
                            timeout=aiohttp.ClientTimeout(total=10),
                            allow_redirects=True,
                        ) as follow_resp:
                            for host_cookies in session.cookie_jar._cookies.values():
                                for path_cookies in host_cookies.values():
                                    for name, cookie in path_cookies.items():
                                        val = cookie.value if hasattr(cookie, 'value') else cookie
                                        cookie_str += f"{name}={val}; "
                    except Exception:
                        pass

                if cookie_str:
                    COOKIE_FILE.write_text(cookie_str.strip(), encoding='utf-8')
                    COOKIE_FILE.chmod(0o600)

                success_image = make_success_image()

                return {
                    "ok": True,
                    "status": "logged_in",
                    "success_image": success_image,
                    "note": "Cookie已保存到 .cx_cookie",
                    "qr_refreshes": qr_refresh_count,
                }

            # ★ QR 过期 → 返回新 QR 给前端显示 (必须返回, 否则用户扫的是旧QR)
            resp_type = str(data.get('type', ''))
            if resp_type == '2':
                new_qr = await _fresh_qr(session)
                if new_qr:
                    return {
                        "ok": False,
                        "status": "expired_refreshed",
                        "error": "二维码已过期，已自动刷新。请用新二维码重新扫码",
                        "qr_image_base64": new_qr['qr_image_base64'],
                        "qr_image_url": new_qr['qr_image_url'],
                        "enc": new_qr['enc'],
                        "uuid": new_qr['uuid'],
                        "expires_in": 60,
                    }

            # 延长间隔防止被限
            if poll_count > 45:
                await asyncio.sleep(1)

        # 超时 — 返回最新 QR 数据让模型可以重试
        return {
            "ok": False,
            "status": "timeout",
            "error": f"等待超时({max_wait}秒)，用户未扫码。QR已过期,请用auto重新生成",
            "qr_refreshes": qr_refresh_count,
        }


# ═══════════════════════════════════════════════════
# 非阻塞生成 QR (auto/qr → 立即返回显示给用户)
# ═══════════════════════════════════════════════════

async def auto_login():
    """生成QR立即返回, 不阻塞。模型拿到QR后应立即调 action=login 等待扫码"""
    qr = await generate_qrcode()
    if not qr.get("ok"):
        return qr

    return {
        "ok": False,
        "status": "qr_ready",
        "qr_image_base64": qr.get("qr_image_base64", ""),
        "qr_image_url": qr.get("qr_image_url", ""),
        "enc": qr.get("enc", ""),
        "uuid": qr.get("uuid", ""),
        "expires_in": 60,
        "message": (
            f"📷 二维码已生成: {qr.get('qr_image_url', '')}\n"
            f"请把二维码显示给用户扫描，然后立即调 chaoxing_qr_login(action=login, "
            f"enc=\"{qr.get('enc', '')}\", uuid=\"{qr.get('uuid', '')}\") "
            "等待扫码结果"
        ),
    }


# ═══════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: chaoxing-login.py [check|qr|login] [timeout]"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'check':
        print(json.dumps(await check_cookie(), ensure_ascii=False))
    elif cmd in ('qr', 'auto'):
        # qr/auto = 生成QR立即返回(非阻塞), 模型拿到QR后调 login 阻塞等待
        print(json.dumps(await auto_login(), ensure_ascii=False))
    elif cmd in ('login', 'poll'):
        # login/poll = 阻塞轮询, 优先用传入的 enc/uuid
        enc = sys.argv[2] if len(sys.argv) > 2 else ''
        uuid = sys.argv[3] if len(sys.argv) > 3 else ''
        timeout = int(sys.argv[4]) if len(sys.argv) > 4 else 300
        print(json.dumps(await login_action(enc, uuid, timeout), ensure_ascii=False))
    else:
        print(json.dumps({"error": f"未知命令: {cmd}"}))


if __name__ == '__main__':
    asyncio.run(main())
