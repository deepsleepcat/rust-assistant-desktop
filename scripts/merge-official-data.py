"""
增量补全脚本：从官方 VS Code 扩展仓库（RustedWarfareModSupport 1.15）
提取缺失字段的中文翻译，追加到 public/data/translations.json。

来源：
  data/sections/<节>.json      → 字段名（name）+ 值类型（type）
  translation/zh-cn/<节>.json  → key `data.sections.<节>.<字段>` → 中文名

只追加现有词典（code.json + translations.json）缺失的翻译对，不覆盖已有数据。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OFFICIAL = Path(r"W:\mao\tx\RustedWarfareModSupport-rustedwarfare-1.15")
CODE_JSON = ROOT / "public" / "data" / "code.json"
TRANS_JSON = ROOT / "public" / "data" / "translations.json"


def _under_root(p: Path) -> Path:
    """解析并校验路径必须在项目根内（防误写项目外文件）"""
    rp = p.resolve()
    if not str(rp).startswith(str(ROOT.resolve())):
        raise SystemExit(f"路径越出项目根目录: {p}")
    return rp


def main():
    sections_dir = OFFICIAL / "data" / "sections"
    zh_dir = OFFICIAL / "translation" / "zh-cn"

    with open(_under_root(CODE_JSON), encoding="utf-8") as fh:
        codes = json.load(fh)
    with open(_under_root(TRANS_JSON), encoding="utf-8") as fh:
        trans = json.load(fh)

    existing_codes = {c.get("code") for c in codes.get("data", [])}
    trans_words = trans.get("words", [])
    existing_pairs = {(w.get("en"), w.get("zh")) for w in trans_words}

    # 收集官方（节, 字段名, 中文名）
    new_pairs = []
    skipped = 0
    for sec_file in sorted(sections_dir.glob("*.json")):
        section = sec_file.stem
        zh_file = zh_dir / f"{section}.json"
        if not zh_file.exists():
            continue
        zh_map = json.load(open(zh_file, encoding="utf-8"))
        sec_data = json.load(open(sec_file, encoding="utf-8"))
        for item in sec_data.get("data", []):
            name = item.get("name")
            if not name or not isinstance(name, str):
                continue
            if name in existing_codes:
                continue  # code.json 已有（含其翻译）
            zh = zh_map.get(f"data.sections.{section}.{name}")
            if not zh or not isinstance(zh, str) or len(zh.strip()) == 0:
                skipped += 1
                continue
            if (name, zh) in existing_pairs:
                continue
            new_pairs.append({"en": name, "zh": zh.strip()})

    # 去重（en 相同只留一条）
    seen = set()
    deduped = []
    for p in new_pairs:
        if p["en"] in seen:
            continue
        seen.add(p["en"])
        deduped.append(p)

    trans["words"].extend(deduped)
    # 写回数据：路径先经 _under_root 边界校验（必须在项目根内）
    _under_root(TRANS_JSON).write_text(json.dumps(trans, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"追加缺失翻译 {len(deduped)} 条（跳过无中文 {skipped} 条）")
    print(f"translations.json 现共 {len(trans['words'])} 条")
    for p in deduped[:8]:
        print(f"  {p['en']} → {p['zh']}")


if __name__ == "__main__":
    main()
