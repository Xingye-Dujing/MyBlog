# -*- coding: utf-8 -*-
"""Filesystem helpers shared by the save-path, share-path and plugin-root
migrations.

All three features need the same guarantees:

* merge a directory tree into another one without losing a name collision
* move across drives (``shutil.move`` handles copy + delete)
* remove the source completely, including empty sub-directories, but never
  walk above the directory the user asked to move
* roll back if a move fails halfway through

Keeping this in one module keeps the three call sites honest.
"""
from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path
from typing import Dict, Optional, Union

PathLike = Union[str, os.PathLike]


def resolve(path: PathLike) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(path)))).resolve()


def is_inside(child: PathLike, parent: PathLike) -> bool:
    try:
        child_p = resolve(child)
        parent_p = resolve(parent)
    except OSError:
        return False
    return child_p == parent_p or parent_p in child_p.parents


def is_nested(a: PathLike, b: PathLike) -> bool:
    """True when one path contains the other (moving would recurse)."""
    return is_inside(a, b) or is_inside(b, a)


def unique_target(directory: Path, name: str) -> Path:
    """Return a free path in ``directory``, keeping the extension visible."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    if not target.exists():
        return target
    stem, suffix = os.path.splitext(name)
    if not stem:  # dotfile such as ".gitignore"
        stem, suffix = name, ""
    for index in range(2, 1000):
        candidate = directory / ("%s-%d%s" % (stem, index, suffix))
        if not candidate.exists():
            return candidate
    return directory / ("%s-%s%s" % (stem, uuid.uuid4().hex[:6], suffix))


def merge_tree(src: PathLike, dst: PathLike, mapping: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Move every child of ``src`` into ``dst``, merging directories.

    Files that already exist at the destination are kept; the incoming file is
    renamed (``report-2.pdf``) instead of overwriting anything.  ``mapping``
    records ``old absolute path -> new absolute path`` so callers can rewrite
    references in their own indexes.
    """
    source = resolve(src)
    target = resolve(dst)
    moves = mapping if mapping is not None else {}
    if not source.is_dir():
        return moves
    if source == target:
        return moves
    # Moving into a sub-directory of the source would recurse forever.  Moving
    # up into an ancestor is fine: we only iterate the source's children.
    if is_inside(target, source):
        raise ValueError("目标目录不能位于源目录内部：%s → %s" % (source, target))
    target.mkdir(parents=True, exist_ok=True)

    for item in sorted(source.iterdir(), key=lambda path: path.name.lower()):
        if item.is_symlink():
            # Never follow a link out of the tree.  Move the link itself.
            final = unique_target(target, item.name)
            shutil.move(str(item), str(final))
            moves[str(item)] = str(final)
            continue
        if item.is_dir():
            child_target = target / item.name
            child_target.mkdir(parents=True, exist_ok=True)
            merge_tree(item, child_target, moves)
            try:
                item.rmdir()
            except OSError:
                pass
            continue
        final = unique_target(target, item.name)
        shutil.move(str(item), str(final))
        moves[str(item)] = str(final)
    return moves


def rollback(moves: Dict[str, str]) -> None:
    """Undo ``merge_tree`` moves in reverse order (best effort)."""
    for old, new in reversed(list(moves.items())):
        new_path = Path(new)
        old_path = Path(old)
        if not new_path.exists():
            continue
        try:
            old_path.parent.mkdir(parents=True, exist_ok=True)
            if not old_path.exists():
                shutil.move(str(new_path), str(old_path))
        except OSError:
            pass


def remove_empty_tree(root: PathLike) -> bool:
    """Remove ``root`` and every empty directory below it.

    Returns True when the root itself is gone.  A directory that still holds a
    file is left alone; the caller can report it as a leftover instead of
    pretending the migration was complete.
    """
    path = resolve(root)
    if not path.is_dir():
        return True
    try:
        children = sorted(path.rglob("*"), key=lambda item: len(item.parts), reverse=True)
    except OSError:
        children = []
    for child in children:
        if child.is_symlink():
            try:
                child.unlink()
            except OSError:
                pass
            continue
        if child.is_dir():
            try:
                child.rmdir()
            except OSError:
                pass
    try:
        path.rmdir()
        return True
    except OSError:
        return False


def unsafe_bulk_root(path: PathLike) -> bool:
    """Refuse to bulk-move a standard user folder such as Documents or Home.

    A save directory normally points at ``Documents/OMM-ZEN``; if a user once
    pointed it at ``Documents`` itself, moving *everything* would be reckless.
    In that case the caller migrates only the files it registered.
    """
    target = resolve(path)
    home = Path.home().resolve()
    protected = {
        home,
        home.parent,
        home / "Desktop",
        home / "Documents",
        home / "Downloads",
        home / "Pictures",
        home / "Music",
        home / "Videos",
    }
    if target in protected:
        return True
    try:
        anchor = Path(target.anchor).resolve()
    except OSError:
        anchor = None
    return bool(anchor and target == anchor)
