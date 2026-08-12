# 铁锈战争模组开发指南（AI 增强版）

> 本指南是 `references/rusted-warfare-modding.md`（完整代码参考，基于官方 1.14+ 代码表）的**使用指南与增强补充**。
> AI 写模组时：先读本指南掌握组织规范与骨架，需要具体字段/语法细节时再查完整参考或 `examples/` 真实范例。
> 适用于铁锈战争 1.14 / 1.15（含 1.15p9）。

---

## 一、模组最小可理解结构（AI 必须先懂这个）

### 1. 一个模组 = 一个文件夹

```
模组根目录/
├─ mod-info.txt        ← 入口文件，游戏靠它识别模组
├─ xxx.png             ← 模组缩略图（thumbnail 引用）
├─ all-units.template  ← 全局配置（可选）
└─ 任意子目录/          ← 单位文件夹，任意层级
```

### 2. 一个单位 = 一个文件夹 + 一个 .ini + 同目录 .png

```
单位目录/
├─ 单位名.ini   ← 单位定义（可以多个 ini，文件夹内都算）
└─ 单位名.png   ← 贴图
```

### 3. 最小可玩单位骨架（仅 4 个节）

```ini
[core]
name: 测试单位          # 全局唯一！
maxHp: 100
mass: 1
price: 100
radius: 10
tags: 测试

[graphics]
image: 测试单位.png
image_wreak: 测试单位炸了.png
total_frames: 1
image_shadow: AUTO

[attack]
[projectile_1]
directDamage: 10
life: 5
speed: 200
[attack]/[turret_1] 需要时可加炮塔

[movement]
movementType: LAND     # NONE/LAND/BUILDING/AIR/WATER/HOVER/OVER_CLIFF...
moveSpeed: 50
```

### 4. 引用规则（最容易出错，务必遵守）

- **单位名（name:）全模组唯一**，跨文件引用靠它：`canBuild_1_name:建造者`、`builtFrom_1_name:0级星球`、`unitsSpawnedOnDeath:迷你爆炸`；
- **路径**：同目录直接写文件名；模组根用 `ROOT:素材/dg.png`；原版素材用 `SHARED:light_50.png`；
- **节名关联**：`[turret_1]`、`[projectile_1]`、`[effect_xjqbz]`、`[resource_矿]` 靠节名前缀与名称关联；
- **模板继承**：`copyFrom:ROOT:模板/单位衰变.template,ROOT:模板/指挥舰.template`（逗号分隔多重继承）；
- **一切皆单位**：爆炸、特效、天体、判定器都是隐形单位（`isUnselectable:true`、`disableDeathOnZeroHp:true`）。

### 5. 语法规范（来自完整参考）

- 键值用**英文冒号**：`name:value`（不用等号）；
- 布尔用 `true/false`；
- 路径分隔用 `/`；
- 多行字符串用 `""" text """`；
- 注释用 `#`；
- 时间带单位：`5s`、`30s`、`0.1s`；
- 颜色：`#RRGGBB` 或 `#AARRGGBB`；
- 列表：`tags:粉末,舰载机`；
- 表达式：`${movement.moveSpeed}*0.1*self.resource.指挥速度`；
- 条件：`autoTrigger:if numberOfUnitsInNeutralTeam(withinRange=90,withTag='fe',greaterThan=0) and not self.hasResources(物质质量=0.2)`。

---

## 二、mod-info.txt 写法（入口文件）

```ini
[mod]
title: 我的模组
description: 模组介绍第一行\n第二行（\n 换行）
thumbnail: 深渊星辰.png
minVersion: 1.15p9

[music]
sourceFolder: music/
whenUsingUnitsFromThisMod_playExclusively: true

[maps]
sourceFolder: maps/
addExtraMapsForPath: true
```

---

## 三、真实模组组织规范（从《深渊星辰》提炼）

### 目录组织

```
模组根/
├─ 0级文明/ 1级文明/ ...   ← 阵营 → 科技等级
│  └─ 巡洋舰/
│     ├─ 照映.ini
│     └─ 照映.png
├─ 模板/                   ← 可复用 .template
├─ 素材/                   ← 共享素材（粒子/光效/音效），ROOT:素材/xxx 引用
├─ 机制/                   ← 隐形逻辑单位（生成器/判定器）
├─ maps/  music/
└─ all-units.template      ← 全局资源定义
```

### 单位 ini 标准节顺序

```
[core] → [hiddenAction_*] → [action_*] → [resource_*] → [graphics]
→ [attack] → [turret_X] → [projectile_X] → [movement] → [ai] → [effect_*]
```

### 命名规范

- 单位名：中文名（`照映-巡洋舰`），同名变体加后缀（`照映-巡洋舰（海盗）`）；
- 节名前缀：`turret_`/`projectile_`/`action_`/`hiddenAction_`/`resource_`/`effect_`/`decal_`/`attachment_`/`canBuild_`/`global_resource_`，后接数字或名称；
- `[resource_X]` 节名必须与资源 key 完全一致；
- 特效引用：`CUSTOM:xjqbz*2` → 定义在 `[effect_xjqbz]`，`*N` 为数量；
- 图片：本体 `xxx.png`、残骸 `xxx炸了.png`、多帧 `xxxa.png`。

### 进阶三板斧（深渊星辰大量使用）

1. **模板继承**：`copyFrom:ROOT:模板/单位衰变.template` 复用通用逻辑；
2. **hiddenAction 状态机**：自定义资源当计数器——`addResources:异常=1` → `hasResources(异常=45)` → `addResources:异常=-45`，`autoTriggerOnEvent: destroyed/tookDamage` 触发；
3. **action 玩家技能**：`[action_跃迁]` + `setUnitStats`、`isLocked`、`ai_isDisabled`。

---

## 四、真实范例速查（examples/ 目录）

| 文件 | 用途 | 适合抄什么 |
| --- | --- | --- |
| `examples/照映.ini` | 最佳完整范例 | 运输舰/双炮塔/技能/状态机全结构 |
| `examples/建造者.ini` | 建造者范式 | canBuild/builtFrom/nano/AI 行为 |
| `examples/机炮.ini` | 炮塔建筑 | 炮塔+抛射体+convertTo 升级链 |
| `examples/单位衰变.template` | 基础模板 | copyFrom 继承的模板写法 |
| `examples/判定模板.txt` | 逻辑单位骨架 | 隐形判定单位最小结构 |
| `examples/迷你爆炸.ini` | 死亡特效单位 | effectOnDeath/overrideAndReplace |
| `examples/mod-info.txt` | 模组入口 | 三段式入口写法 |
| `examples/黄矮星2.ini` | 复杂单位 | decal 光效/map 表达式/spawnUnits |

**AI 遇到问题时**：先看 examples/ 里有没有相似范例，模仿其结构再写，不要凭空造。

---

## 五、给 AI 的写作规范

1. 输出**中文解释 + 英文代码**；
2. 新单位必须 `name:` 全局唯一；
3. 新资源必须在 `[resource_X]` 节声明 displayName；
4. 被引用的单位名/标签名前后一致；
5. 模板继承优先于复制粘贴；
6. 不确定的字段查 `references/rusted-warfare-modding.md`；
7. 标注已弃用字段（`turretSize`、`globalScale`、`action_#_convertTo` 等）；
8. 修改文件前给出 Diff 并等待用户确认。
