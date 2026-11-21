# 技能体系

OMM-ZEN 的 AI 技能定义在 `agent_workspace/omm_skills.py`，全部是纯数据
（prompt + context + tools），不含业务逻辑。技能分四组：

| 组 | 技能 | 用途 |
|---|---|---|
| `products` | `omm.zen.<id>` | 每个产品一个专家模式，由其 `omm_data.PRODUCTS` 条目自动衍生 |
| `workspace` | `omm.zen.hub` / `omm.zen.cross` | 工作台管控与跨产品编排 |
| `authoring` | `omm.zen.ai` / `omm.zen.study` | AI 工作区管家与学习包设计师 |
| `authoring` | `omm.zen.dev` | 开发者技能：按本设计系统开发新产品 |

所有技能共享隐私红线（隐藏内容、凭据一律不读取不输出）与工具白名单。

## 新增产品技能

只需在 `omm_data.py` 的 `PRODUCTS` 增加条目，`build_skills()` 会自动生成对应技能。
不要手改 `omm_skills.py` 中的产品技能列表。

## 新增通用技能

在 `omm_skills.py` 的 `extras` 增加 `SkillSpec`，提供 `id`、名称、描述、prompt、
suggested 示例与 group，并补测试。所有技能自动追加隐私守则。

## 开发者技能

`omm.zen.dev` 把本文档体系注入模型：令牌真源、层顺序、组件词汇、共享模块、
桥接协议、注册与发布流程。开发新产品时可先切换到该技能，让它按
`docs/product-guide.md` 生成入口页、产品 CSS、注册条目与测试骨架。
