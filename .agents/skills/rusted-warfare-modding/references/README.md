# Rusted Warfare Modding Reference Map

This directory is the deep reference layer for the project-local `rusted-warfare-modding` skill. Start with [SKILL.md](../SKILL.md), then read the smallest topical file that resolves the task. The documents are internal engineering guidance for Rusted Warfare 1.14/1.15 and distinguish loader facts from examples and compatibility observations.

| File | Read when |
| --- | --- |
| [00-source-authority-and-versioning.md](00-source-authority-and-versioning.md) | Deciding what evidence can support a claim or which version is in scope |
| [01-mod-discovery-rwmod-and-metadata.md](01-mod-discovery-rwmod-and-metadata.md) | Handling `mod-info.txt`, discovery, rwmod, ZIP layout, or metadata |
| [02-ini-parser-templates-and-inheritance.md](02-ini-parser-templates-and-inheritance.md) | Parsing INI, templates, variables, `copyFrom`, or `all-units.template` |
| [03-unit-architecture-and-field-catalog-routing.md](03-unit-architecture-and-field-catalog-routing.md) | Designing a unit or locating the exact field reference |
| [04-actions-logic-resources-effects-and-state.md](04-actions-logic-resources-effects-and-state.md) | Implementing conditions, actions, state, resources, effects, or performance safeguards |
| [05-assets-audio-localization-and-maps.md](05-assets-audio-localization-and-maps.md) | Resolving images, audio, translated text, music, maps, or TSX assets |
| [06-cross-references-validation-and-debugging.md](06-cross-references-validation-and-debugging.md) | Reviewing references, interpreting loader errors, or planning a debug run |
| [07-packaging-release-and-regression.md](07-packaging-release-and-regression.md) | Building a release archive or test matrix |
| [08-case-study-abyss-stars.md](08-case-study-abyss-stars.md) | Applying source-mod patterns from DeepStar safely |
| [09-case-study-aseu.md](09-case-study-aseu.md) | Applying ASEU patterns and avoiding its historical traps |
| [10-instance-mod-compatibility-matrix.md](10-instance-mod-compatibility-matrix.md) | Selecting real archive compatibility fixtures |
| [11-agent-prompts-and-task-playbooks.md](11-agent-prompts-and-task-playbooks.md) | Giving a coding agent a bounded, evidence-based mod task |
| [12-known-limitations-and-errata.md](12-known-limitations-and-errata.md) | Reconciling simulators, legacy summaries, and unresolved uncertainty |

## Evidence Corpus

The reference was derived from these local resources without copying protected loader source or third-party full mod content:

| Source | Use | Authority |
| --- | --- | --- |
| `W:\mao\tx\tools\decompilers\game-lib-src` | Inspect actual loader semantics for the locally installed game build | Highest for behavior |
| `W:\mao\tx\模组加载器` | Internal readable mapping and partial analyzer | Helpful, but must yield to raw loader behavior |
| `W:\mao\tx\ohmytx\assets\ai\references\rusted-warfare-modding.md` | Existing field vocabulary and routing catalog | Field lookup, verify consequential claims |
| `W:\mao\tx\AbyssStars深渊星辰0.7.10` | Complex owned source-mod organization and regression sample | Pattern and test evidence |
| `W:\mao\tx\ASEU深渊星辰-深渊扩展DLCX` | Extension mod organization and advanced mechanism sample | Pattern and test evidence |
| `W:\mao\tx\模组实例` | Third-party rwmod archive diversity | Compatibility coverage only |
| `W:\mao\tx\模组实例\特殊` | Curated mirror subset of 11 parent-corpus archive paths | Focused loading-format coverage only; not 11 additional independent samples |

The decompiled loader directory is marked as non-public. This skill records derived rules, not source excerpts. Do not package, paste, or redistribute that material. The third-party sample archives are not a source of reusable assets or code; inspect them only as read-only compatibility fixtures.

## Distribution Boundary

`W:\mao\tx\AbyssStars深渊星辰0.7.10`、`W:\mao\tx\ASEU深渊星辰-深渊扩展DLCX`、`W:\mao\tx\模组加载器`、`W:\mao\tx\模组实例\**`（包括 `特殊\**`）都是工作区外的研究来源。它们不能复制到 `public/`、`dist/`、`dist-electron/`、`extraResources` 或 `extraFiles`，也不能作为 Electron 桌面应用的内置资源。

这条边界只约束桌面应用发行包。用户主动选择项目根后使用“打包模组”生成自己的 `.rwmod` 是独立工作流，本 skill 不改变该能力；实际发布自己的模组仍应从干净 staging 根生成，而不是从参考语料目录直接构建。

## Corpus Coverage Contract

The derived coverage facts and audit scope are recorded in [corpus-inventory.json](corpus-inventory.json). It is deliberately a small fact inventory rather than a copy of any source corpus.

- The two DeepStar source trees are treated as real-world examples, not as an authority for unknown fields or key casing.
- Every `.rwmod` path in `模组实例\**`（包括 `特殊\**`）都应逐个传给 bundled auditor；直接把语料目录本身传给单 archive 审计器不能替代逐文件检查。发布工作流必须记录不可读和 manifest-less 样本，而不是隐藏它们。
- The authoritative unit-field catalog remains separate because copying it would create duplicate, divergent field documentation. Route exact field questions there, then record a correction in `12-known-limitations-and-errata.md` when engine evidence disagrees.
- Static validation and game testing complement each other. Neither one alone proves a complete mod release.
