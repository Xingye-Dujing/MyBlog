# -*- coding: utf-8 -*-
"""让 pytest 从仓库根目录解析 agent_workspace 与 desktop 模块。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for path in (ROOT, ROOT / 'desktop'):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)


# 框架自带的全仓库引号门禁现在与 tools/check_quote_style.py 共用同一套排除规则：
# .workbuddy/ 历史目录、vendor/ 第三方包、build/ 与 dist/ 构建产物都不再参与扫描，
# OMM 自写的 agent_workspace/omm_*.py 也已清零角括号。因此这条门禁不再跳过，
# 框架与产品共用一道防线。
