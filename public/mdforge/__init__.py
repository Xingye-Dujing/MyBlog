"""MdForge — Markdown to reference-grade DOCX / TeX."""
from .convert import convert_file, convert_text, edit_metadata
from .compiler import compile_tex

__all__ = ["convert_file", "convert_text", "edit_metadata", "compile_tex"]
__version__ = "1.0.0"
