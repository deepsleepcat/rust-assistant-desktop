"""
全量缺失审计：对比官方 RustedWarfareModSupport 1.15 数据与电脑版词典，
找出所有缺失的字段/节/词条翻译。
输出分三类：①mod-info 专有字段 ②官方有中文可补 ③官方无中文（宏字段）。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OFFICIAL = Path(r"W:\mao\tx\RustedWarfareModSupport-rustedwarfare-1.15")

code = json.load(open(ROOT / "public" / "data" / "code.json", encoding="utf-8"))
trans = json.load(open(ROOT / "public" / "data" / "translations.json", encoding="utf-8"))
sections = json.load(open(ROOT / "public" / "data" / "section.json", encoding="utf-8"))

existing = {c["code"] for c in code["data"]}
existing |= {w["en"] for w in trans["words"]}
existing |= {s["code"] for s in sections["data"]}

# 官方字段 → 中文
missing_with_zh = []
missing_no_zh = []
for sec_file in sorted((OFFICIAL / "data" / "sections").glob("*.json")):
    section = sec_file.stem
    zh_map = {}
    zh_file = OFFICIAL / "translation" / "zh-cn" / f"{section}.json"
    if zh_file.exists():
        zh_map = json.load(open(zh_file, encoding="utf-8"))
    sec_data = json.load(open(sec_file, encoding="utf-8"))
    for item in sec_data.get("data", []):
        name = item.get("name")
        if not name or not isinstance(name, str) or name in existing:
            continue
        zh = zh_map.get(f"data.sections.{section}.{name}")
        if zh and isinstance(zh, str) and zh.strip():
            missing_with_zh.append((section, name, zh.strip()))
        else:
            missing_no_zh.append((section, name, item.get("type", "")))

# mod-info 专有字段检查
mod_info_fields = [
    ("title", "标题"), ("description", "描述"), ("thumbnail", "缩略图"),
    ("version", "版本"), ("author", "作者"), ("minVersion", "最低版本"),
    ("tags", "标签"), ("sourceFolder", "源文件夹"),
    ("whenUsingUnitsFromThisMod_playExclusively", "使用本模组单位时独占播放"),
    ("addExtraMapsForPath", "添加额外地图路径"),
    ("music", "音乐"), ("maps", "地图"), ("mod", "模组"),
]
print("=== ① mod-info 专有字段缺失 ===")
for en, zh in mod_info_fields:
    if en not in existing:
        print(f"  {en} → {zh}")

print(f"\n=== ② 官方有中文、词典缺失：{len(missing_with_zh)} 条 ===")
for section, name, zh in missing_with_zh:
    print(f"  [{section}] {name} → {zh}")

print(f"\n=== ③ 官方无中文（宏字段等）：{len(missing_no_zh)} 条 ===")
for section, name, vtype in missing_no_zh:
    print(f"  [{section}] {name} ({vtype})")
