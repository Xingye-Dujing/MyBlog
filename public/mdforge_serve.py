# -*- coding: utf-8 -*-
"""MdForge launcher.

    .venv/Scripts/python.exe mdforge_serve.py
    .venv/Scripts/python.exe mdforge_serve.py --port 8140 --open
"""
from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from mdforge.compiler import environment_info
from mdforge.server import app


def port_in_use(host: str, port: int) -> bool:
    probe_host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.35)
            return sock.connect_ex((probe_host, int(port))) == 0
    except OSError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="MdForge — Markdown to DOCX / TeX studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8140)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()
    if port_in_use(args.host, args.port):
        print(
            "[错误] 端口 %d 已被占用。可能已有一个 MdForge 服务在运行；请关闭旧进程或换用 --port。"
            % args.port,
            file=sys.stderr,
        )
        sys.exit(1)
    env = environment_info()
    print("MDFORGE  http://%s:%d" % (args.host, args.port))
    print("MiKTeX  ", env.get("miktex_bin") or "未找到")
    print("latexmk ", env.get("latexmk") or "未找到")
    print("engines ", ", ".join(k for k, v in env.get("engines", {}).items() if v) or "无")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open("http://%s:%d/omm-mdforge.html" % (args.host, args.port))).start()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
