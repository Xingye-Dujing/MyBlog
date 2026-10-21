"""MiKTeX / latexmk compilation wrapper."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from .errors import CompileError

_ENGINES = ("xelatex", "lualatex", "pdflatex")
_COMPILE_LOCK = threading.Lock()
_CANDIDATE_BINS = [
    os.environ.get("MIKTEX_BIN", ""),
    r"D:\MiKTeX\miktex\bin\x64",
    r"C:\Program Files\MiKTeX\miktex\bin\x64",
    r"C:\Program Files\MiKTeX 2.9\miktex\bin\x64",
]


def find_miktex_bin() -> Optional[str]:
    for candidate in _CANDIDATE_BINS:
        if candidate and os.path.isdir(candidate):
            for engine in _ENGINES:
                if os.path.isfile(os.path.join(candidate, engine + ".exe")):
                    return os.path.normpath(candidate)
    for engine in _ENGINES:
        location = shutil.which(engine)
        if location:
            return os.path.dirname(location)
    return None


def _env(miktex_bin: Optional[str]) -> Dict[str, str]:
    env = dict(os.environ)
    if miktex_bin:
        env["PATH"] = miktex_bin + os.pathsep + env.get("PATH", "")
    env["MIKTEX_AUTOINSTALL"] = "1"
    env["max_print_line"] = "1000"
    return env


def find_latexmk(miktex_bin: Optional[str]) -> Optional[str]:
    if miktex_bin:
        for name in ("latexmk.exe", "latexmk"):
            path = os.path.join(miktex_bin, name)
            if os.path.isfile(path):
                return path
    return shutil.which("latexmk")


def environment_info() -> Dict[str, Any]:
    miktex_bin = find_miktex_bin()
    engines = {}
    for engine in _ENGINES:
        path = None
        if miktex_bin:
            candidate = os.path.join(miktex_bin, engine + ".exe")
            if os.path.isfile(candidate):
                path = candidate
        if not path:
            path = shutil.which(engine)
        engines[engine] = bool(path)
    latexmk = find_latexmk(miktex_bin)
    version = ""
    if miktex_bin:
        exe = os.path.join(miktex_bin, "xelatex.exe")
        if os.path.isfile(exe):
            try:
                result = subprocess.run(
                    [exe, "--version"],
                    capture_output=True,
                    timeout=20,
                    env=_env(miktex_bin),
                    creationflags=0x08000000,
                )
                text = _decode(result.stdout) + _decode(result.stderr)
                match = re.search(r"MiKTeX\s+([0-9.]+)", text)
                version = match.group(1) if match else (text.splitlines()[0] if text else "")
            except Exception:
                version = ""
    return {
        "miktex_bin": miktex_bin or "",
        "engines": engines,
        "latexmk": latexmk or "",
        "version": version,
    }


def _decode(data: Optional[bytes]) -> str:
    if not data:
        return ""
    for encoding in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except Exception:
            continue
    return data.decode("utf-8", "replace")


def _extract_errors(log: str) -> List[Dict[str, Any]]:
    errors: List[Dict[str, Any]] = []
    lines = log.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        file_match = re.match(r"^(.+?\.tex):(\d+):\s*(.+)$", stripped)
        if file_match:
            errors.append({"line": int(file_match.group(2)), "message": file_match.group(3).strip()})
            continue
        if stripped.startswith("!"):
            message = stripped.lstrip("!").strip()
            line_no = 0
            for lookahead in lines[index + 1 : index + 6]:
                match = re.search(r"l\.(\d+)", lookahead)
                if match:
                    line_no = int(match.group(1))
                    break
            errors.append({"line": line_no, "message": message})
            if len(errors) >= 30:
                break
    return errors


def _compile_tex_unlocked(
    tex_path: str,
    engine: str = "xelatex",
    output_dir: Optional[str] = None,
    timeout: int = 300,
) -> Dict[str, Any]:
    engine = engine if engine in _ENGINES else "xelatex"
    tex_path = os.path.abspath(tex_path)
    if not os.path.isfile(tex_path):
        raise CompileError("TeX 文件不存在：%s" % tex_path)
    miktex_bin = find_miktex_bin()
    latexmk = find_latexmk(miktex_bin)
    workdir = os.path.dirname(tex_path) or os.getcwd()
    build_dir = output_dir or os.path.join(workdir, "build")
    os.makedirs(build_dir, exist_ok=True)
    env = _env(miktex_bin)
    started = time.time()
    logs: List[str] = []

    if latexmk:
        command = [
            latexmk,
            "-" + engine,
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-outdir=" + build_dir,
            os.path.basename(tex_path),
        ]
        try:
            result = subprocess.run(
                command,
                cwd=workdir,
                env=env,
                capture_output=True,
                timeout=timeout,
                creationflags=0x08000000,
            )
            logs.append(_decode(result.stdout))
            logs.append(_decode(result.stderr))
            code = result.returncode
        except subprocess.TimeoutExpired as exc:
            logs.append(_decode(exc.stdout))
            logs.append(_decode(exc.stderr))
            raise CompileError("MiKTeX 编译超时（%d 秒）" % timeout, "\n".join(logs)[-60000:])
        except Exception as exc:
            raise CompileError("无法启动 latexmk：%s" % exc)
    else:
        engine_path = None
        if miktex_bin:
            candidate = os.path.join(miktex_bin, engine + ".exe")
            if os.path.isfile(candidate):
                engine_path = candidate
        engine_path = engine_path or shutil.which(engine)
        if not engine_path:
            raise CompileError("未找到 MiKTeX / %s，请安装 MiKTeX 或检查 MIKTEX_BIN" % engine)
        code = 1
        for _pass in range(2):
            command = [engine_path, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-output-directory=" + build_dir, os.path.basename(tex_path)]
            try:
                result = subprocess.run(
                    command,
                    cwd=workdir,
                    env=env,
                    capture_output=True,
                    timeout=timeout,
                    creationflags=0x08000000,
                )
                logs.append(_decode(result.stdout))
                logs.append(_decode(result.stderr))
                code = result.returncode
            except subprocess.TimeoutExpired as exc:
                logs.append(_decode(exc.stdout))
                logs.append(_decode(exc.stderr))
                raise CompileError("MiKTeX 编译超时（%d 秒）" % timeout, "\n".join(logs)[-60000:])
            except Exception as exc:
                raise CompileError("无法启动编译器：%s" % exc)

    elapsed = int((time.time() - started) * 1000)
    log_text = "\n".join(part for part in logs if part)
    stem = os.path.splitext(os.path.basename(tex_path))[0]
    pdf_path = os.path.join(build_dir, stem + ".pdf")
    ok = os.path.isfile(pdf_path)
    if not ok:
        errors = _extract_errors(log_text)
        summary = errors[0]["message"] if errors else "MiKTeX 编译失败，未生成 PDF"
        raise CompileError(summary, log_text[-60000:])
    return {
        "ok": True,
        "pdf": pdf_path,
        "ms": elapsed,
        "log": log_text[-60000:],
        "errors": _extract_errors(log_text),
        "engine": engine,
        "returncode": code,
    }


def compile_tex(
    tex_path: str,
    engine: str = "xelatex",
    output_dir: Optional[str] = None,
    timeout: int = 300,
) -> Dict[str, Any]:
    """Serialize MiKTeX calls: its package database is not concurrency-safe."""
    with _COMPILE_LOCK:
        return _compile_tex_unlocked(tex_path, engine=engine, output_dir=output_dir, timeout=timeout)
