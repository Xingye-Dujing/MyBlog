# -*- coding: utf-8 -*-
"""
omm-analysis-server.py — 舆情演化分析交互式教程 · 可选 Python 后端
零依赖启动：python omm-analysis-server.py   → 浏览器打开 http://127.0.0.1:8765
装了 pandas / matplotlib 后，教程里的代码单元格将真实执行；
未安装的库（jieba/gensim/sklearn/paddlenlp）会自动回退到浏览器内置模拟。
安全说明：仅限本机使用；代码在独立子进程 + 临时目录中执行，20 秒超时强杀。
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8765
ROOT = os.path.dirname(os.path.abspath(__file__))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
}

# 子进程内执行的包装器：预置演示数据环境 → 跑用户代码 → 抓 stdout 与图表
CHILD = r'''
# -*- coding: utf-8 -*-
import contextlib, io, json, os, sys, base64, math, time, random
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
out = io.StringIO()
result = {"ok": True, "stdout": "", "figs": [], "error": ""}

# ---------- 预置环境：让教程示例代码开箱即跑 ----------
url = api_url = "https://example.invalid/comments"
STOPWORDS = {"的", "了", "是", "我", "很", "都", "也", "就", "不", "在", "和", "有"}
_POOL = [
    "这家餐厅吃坏肚子了", "食品安全问题必须重视", "味道还不错价格实惠推荐",
    "商家回应会加强管理", "再也不来了差评投诉", "卫生太差必须整改",
    "支持维权必须给个说法", "已经投诉到监管部门", "性价比其实挺高的",
]
class _FakeResp:
    def __init__(self, data, code=200):
        self._data, self.status_code = data, code
    def json(self):
        return self._data
class _FakeRequests:
    def get(self, u, params=None, headers=None, timeout=None, **kw):
        page = (params or {}).get("page", 1)
        n = 80 if page < 378 else 54          # 377×80+54 = 30214，与教程故事数字一致
        items = [{
            "text": _POOL[i % len(_POOL)] + "！！" * (i % 3),
            "created_at": "2024-03-%02d %02d:%02d" % (7 + page, i % 24, (i * 7) % 60),
            "like_count": (i * 37) % 400,
            "user": {"name": "用户%03d" % i},
        } for i in range(n)]
        return _FakeResp({"comments": items})
requests = _FakeRequests()
time.sleep = lambda s: None                   # 演示环境：延时设为空操作，整条流水线秒级跑完

try:
    import pandas as _pd
    random.seed(42)
    rows = []
    for i in range(30214):
        r = random.random()
        if r < 0.011:
            text = None
        elif r < 0.06:
            text = random.choice(["111", "+1", "转发微博", "沙发"])
        else:
            text = random.choice(_POOL) + random.choice(["", " http://t.cn/x1", " [doge]", " @小美"])
        rows.append({"text": text,
                     "time": "2024-03-%02d %02d:%02d" % (1 + int(random.random() * 20), i % 24, (i * 13) % 60),
                     "likes": int(random.random() ** 2 * 500),
                     "user": "用户%05d" % (i % 9000)})
    df = _pd.DataFrame(rows)
    df.to_csv("weibo_comments.csv", index=False)   # 供 read_csv 示例真实读取
    # ---- 预生成各教程单元格的链式产出：任一格子都能独立真实运行 ----
    _DAILY = [2, 3, 2, 4, 6, 14, 38, 72, 95, 60, 40, 28, 20, 15, 11, 8, 6, 5, 4, 3]
    clean = df.drop_duplicates(subset=["text", "user"]).dropna(subset=["text"]).copy()
    clean = clean[clean["text"].astype(str).str.len() >= 5]
    _dates = [_pd.Timestamp("2024-03-01") + _pd.Timedelta(days=i) for i in range(20)]
    pick = random.choices(range(20), weights=_DAILY, k=len(clean))
    clean["time"] = [_dates[i] + _pd.Timedelta(hours=random.randint(0, 23)) for i in pick]
    clean["date"] = clean["time"].dt.date
    clean.to_csv("corpus_clean.csv", index=False)
    daily = clean.groupby("date").size().rename("热度").to_frame()
    daily.index = _pd.to_datetime(daily.index)
    peak_n, peak_d = daily["热度"].max(), daily["热度"].idxmax()
    th = peak_n * 0.15
    act = daily[daily["热度"] >= th]
    start, end = act.index.min(), act.index.max()
    def _as(d):
        if d < start: return "潜伏期"
        if d > end: return "长尾期"
        if d <= peak_d: return "爆发期"
        return "蔓延期" if daily.loc[d, "热度"] >= peak_n * 0.5 else "衰退期"
    daily["阶段"] = [_as(d) for d in daily.index]
    daily.index.name = "date"
    daily.reset_index().to_csv("stage_split.csv", index=False)
    _PROB = {"潜伏期": (.5, .4, .1), "爆发期": (.1, .2, .7), "蔓延期": (.15, .25, .6),
             "衰退期": (.3, .4, .3), "长尾期": (.4, .45, .15)}
    def _lab(st):
        p = _PROB.get(st, (.33, .34, .33)); x = random.random()
        return "positive" if x < p[0] else ("neutral" if x < p[0] + p[1] else "negative")
    clean["阶段"] = clean["date"].map(dict(zip(daily.index.date, daily["阶段"])))
    clean["sentiment"] = [_lab(s) for s in clean["阶段"]]
    clean.to_csv("corpus_sentenced.csv", index=False)
    order = ["潜伏期", "爆发期", "蔓延期", "衰退期", "长尾期"]
    _pd.crosstab(clean["阶段"], clean["sentiment"], normalize="index").reindex(order).to_csv("sentiment_by_stage.csv")
    _pd.DataFrame({"date": [d.isoformat() for d in daily.index.date],
                   "热度指数": [round(v * 10 + random.random() * 50, 1) for v in daily["热度"]]}
                  ).to_csv("qingbo_hot_index.csv", index=False)
    _pd.DataFrame([[45.2, 40.1, 50.3, 30.4, 20.1], [9.8, 45.3, 24.7, 35.2, 19.6],
                   [30.1, 10.2, 15.0, 20.3, 35.4]],
                  index=["T0", "T1", "T2"], columns=order).div(100).to_csv("topic_evolution.csv")
except ImportError:
    df = None

ns = {"__name__": "__main__", "df": df, "url": url, "api_url": api_url,
      "requests": requests, "STOPWORDS": STOPWORDS,
      "math": math, "time": time, "random": random}

try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(payload["code"], "<cell>", "exec"), ns)
except SystemExit:
    pass
except Exception as e:
    result["error"] = "%s: %s" % (type(e).__name__, e)

# ---------- 捕获 matplotlib 图形 ----------
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=110)
        result["figs"].append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
except ImportError:
    pass
except Exception as e:
    result["error"] = result["error"] or ("matplotlib: %s" % e)

result["stdout"] = out.getvalue()
sys.__stdout__.write(json.dumps(result, ensure_ascii=False))
'''


def run_code(code):
    """在子进程临时目录中执行代码，返回 (lines, error)。"""
    workdir = tempfile.mkdtemp(prefix="omm-cell-")
    try:
        proc = subprocess.run(
            [sys.executable, "-I", "-c", CHILD],
            input=json.dumps({"code": code}).encode("utf-8"),
            cwd=workdir, capture_output=True, timeout=20,
        )
        raw = proc.stdout.decode("utf-8", "replace")
        try:
            res = json.loads(raw[raw.index("{"):])
        except Exception:
            return [], "子进程输出异常：" + (raw or proc.stderr.decode("utf-8", "replace"))[:400]
        lines = [{"text": t} for t in res.get("stdout", "").splitlines() if t.strip()]
        if res.get("error"):
            lines.append({"err": True, "text": "运行报错 → " + res["error"]})
        for fig in res.get("figs", []):
            lines.append({"img": fig})
        return lines, res.get("error", "")
    except subprocess.TimeoutExpired:
        return [{"err": True, "text": "执行超时（20 秒），已强制终止"}], "timeout"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("[omm] %s\n" % (fmt % args))

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            pkgs = {}
            for p in ("pandas", "numpy", "matplotlib", "jieba", "gensim", "sklearn"):
                try:
                    __import__(p)
                    pkgs[p] = True
                except ImportError:
                    pkgs[p] = False
            self._send(200, json.dumps({"ok": True, "python": sys.version.split()[0], "packages": pkgs}).encode(), "application/json")
            return
        if path in ("/", "/omm-analysis.html"):
            path = "/omm-analysis.html"
        fpath = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not fpath.startswith(ROOT) or not os.path.isfile(fpath):
            self._send(404, b"not found", "text/plain")
            return
        ext = os.path.splitext(fpath)[1].lower()
        with open(fpath, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    def do_POST(self):
        if self.path != "/api/run":
            self._send(404, b"not found", "text/plain")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n).decode("utf-8"))
            lines, err = run_code(body.get("code", ""))
            ok = not err
            self._send(200, json.dumps({"ok": ok, "lines": lines}, ensure_ascii=False).encode(), "application/json")
        except Exception as e:
            self._send(200, json.dumps({"ok": False, "error": str(e)}).encode(), "application/json")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    addr = "http://%s:%d" % (HOST, PORT)
    print("=" * 56)
    print("  舆情演化分析教程 · Python 后端已启动")
    print("  打开：%s" % addr)
    print("  提示：pandas/matplotlib 已装则代码单元格真实执行；")
    print("        缺库的单元格自动回退浏览器模拟。Ctrl+C 停止。")
    print("=" * 56)
    threading.Timer(0.8, lambda: webbrowser.open(addr)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[omm] 已停止")


if __name__ == "__main__":
    main()
