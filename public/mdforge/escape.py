"""LaTeX escaping helpers."""
import re

_ESCAPES = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "$": r"\$",
    "&": r"\&",
    "%": r"\%",
    "#": r"\#",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}

_PATTERN = re.compile(r"[\\{}$&%#_~^]")


def escape(text: str) -> str:
    if not text:
        return ""
    return _PATTERN.sub(lambda m: _ESCAPES[m.group(0)], str(text))


def escape_url(url: str) -> str:
    if not url:
        return ""
    return (
        str(url)
        .replace("\\", "/")
        .replace("%", r"\%")
        .replace("#", r"\#")
        .replace("&", r"\&")
        .replace("_", r"\_")
        .replace(" ", "%20")
    )


def unescape_dollar(text: str) -> str:
    return re.sub(r"\\([$])", r"\1", text)
