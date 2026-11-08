"""MiKTeX / xelatex compilation wrapper: two fixed engine passes."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from .errors import CompileError

_ENGINES = ("xelatex", "lualatex", "pdflatex")
_ENGINE_EXT = ".exe" if os.name == "nt" else ""
_COMPILE_LOCK = threading.Lock()
if os.name == "nt":
    _DEFAULT_BINS = [
        r"D:\MiKTeX\miktex\bin\x64",
        r"C:\Program Files\MiKTeX\miktex\bin\x64",
        r"C:\Program Files\MiKTeX 2.9\miktex\bin\x64",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64"),
        os.path.expandvars(r"%ProgramFiles%\MiKTeX\miktex\bin\x64"),
    ]
else:
    # macOS: MacTeX installs the stable symlink at /Library/TeX/texbin.
    _DEFAULT_BINS = [
        "/Library/TeX/texbin",
        "/usr/local/texlive/2026/bin/universal-darwin",
        "/usr/local/texlive/2025/bin/universal-darwin",
        "/usr/local/texlive/2024/bin/universal-darwin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]


def _config_path() -> str:
    for key in ("OMM_SHARED_DIR", "OMM_DATA_DIR"):
        folder = os.environ.get(key)
        if folder:
            return os.path.join(folder, "miktex.json")
    return os.path.join(os.path.expanduser("~"), ".omm-zen", "miktex.json")


def _load_config() -> Dict[str, Any]:
    try:
        with open(_config_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_config(**updates) -> Dict[str, Any]:
    path = _config_path()
    data = _load_config()
    data.update(updates)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return data


def has_engine(path: Optional[str]) -> bool:
    if not path or not os.path.isdir(path):
        return False
    return any(os.path.isfile(os.path.join(path, engine + _ENGINE_EXT)) for engine in _ENGINES)


def set_miktex_bin(path: str) -> Optional[str]:
    """Persist a user-chosen MiKTeX bin folder; empty string clears it."""
    raw = (path or "").strip().strip('"')
    if not raw:
        _save_config(miktex_bin="")
        return find_miktex_bin()
    candidate = os.path.normpath(raw)
    if not has_engine(candidate):
        raise ValueError("该目录里找不到 xelatex / pdflatex / lualatex")
    _save_config(miktex_bin=candidate)
    return candidate


def configured_miktex_bin() -> str:
    return str(_load_config().get("miktex_bin") or "")


def find_miktex_bin() -> Optional[str]:
    candidates = [configured_miktex_bin(), os.environ.get("MIKTEX_BIN", "")]
    candidates += _DEFAULT_BINS
    for candidate in candidates:
        if has_engine(candidate):
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


def environment_info() -> Dict[str, Any]:
    miktex_bin = find_miktex_bin()
    engines = {}
    for engine in _ENGINES:
        path = None
        if miktex_bin:
            candidate = os.path.join(miktex_bin, engine + _ENGINE_EXT)
            if os.path.isfile(candidate):
                path = candidate
        if not path:
            path = shutil.which(engine)
        engines[engine] = bool(path)
    version = ""
    if miktex_bin:
        exe = os.path.join(miktex_bin, "xelatex" + _ENGINE_EXT)
        if os.path.isfile(exe):
            try:
                result = subprocess.run(
                    [exe, "--version"],
                    capture_output=True,
                    timeout=20,
                    env=_env(miktex_bin),
                    creationflags=0x08000000 if os.name == "nt" else 0,
                )
                text = _decode(result.stdout) + _decode(result.stderr)
                match = re.search(r"MiKTeX\s+([0-9.]+)", text)
                version = match.group(1) if match else (text.splitlines()[0] if text else "")
            except Exception:
                version = ""
    return {
        "miktex_bin": miktex_bin or "",
        "engines": engines,
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
    workdir = os.path.dirname(tex_path) or os.getcwd()
    build_dir = output_dir or os.path.join(workdir, "build")
    os.makedirs(build_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(tex_path))[0]
    pdf_path = os.path.join(build_dir, stem + ".pdf")
    tex_name = os.path.basename(tex_path)
    tex_arg = os.path.join(".", tex_name) if tex_name.startswith("-") else tex_name
    try:
        if os.path.isfile(pdf_path):
            os.remove(pdf_path)
    except OSError as exc:
        raise CompileError("无法清理旧的 PDF 产物：%s" % exc)
    env = _env(miktex_bin)
    started = time.time()
    logs: List[str] = []

    engine_path = None
    if miktex_bin:
        candidate = os.path.join(miktex_bin, engine + _ENGINE_EXT)
        if os.path.isfile(candidate):
            engine_path = candidate
    engine_path = engine_path or shutil.which(engine)
    if not engine_path:
        raise CompileError("未找到 TeX 引擎 / %s，请安装 TeX 或检查 MIKTEX_BIN" % engine)
    # 生成的 TeX 只有手写 thebibliography 与可选目录，无 BibTeX / makeindex 依赖。
    # 固定两遍让 .toc / .aux 生效即可，无需额外的构建调度程序。
    code = 1
    for _pass in range(2):
        command = [engine_path, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-output-directory=" + build_dir, tex_arg]
        try:
            result = subprocess.run(
                command,
                cwd=workdir,
                env=env,
                capture_output=True,
                timeout=timeout,
                creationflags=0x08000000 if os.name == "nt" else 0,
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
    ok = code == 0 and os.path.isfile(pdf_path)
    if not ok:
        errors = _extract_errors(log_text)
        summary = errors[0]["message"] if errors else "MiKTeX 编译失败，未生成有效 PDF"
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
