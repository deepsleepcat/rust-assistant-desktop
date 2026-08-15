"""
增量补全数据脚本：把用户提供的 xlsx 代码表（1.15 超强版）中
现有 public/data 缺失的词条追加进去，不覆盖已有数据。

用法：
  python scripts/merge-xlsx-data.py "W:\mao\tx\代码表1.15超强版(兼容)0830.xlsx"

来源表结构（sheet「代码表HX」）：
  - 节行：B=中文节名，D=[英文节名]
  - 字段行：B=英文代码(带冒号)，C=中文翻译，D=描述，E=例子，F=值类型
  - "#====" 行为分类分隔符
"""
import json
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
CODE_JSON = ROOT / "public" / "data" / "code.json"
TRANS_JSON = ROOT / "public" / "data" / "translations.json"


def extract_rows(xlsx_path: str):
    wb = openpyxl.load_workbook(xlsx_path, read_only=True)
    ws = wb["代码表HX"]
    current_section = ""
    for row in ws.iter_rows(min_row=2, values_only=True):
        b, c, d, e, f = (row[1] if len(row) > 1 else None,
                         row[2] if len(row) > 2 else None,
                         row[3] if len(row) > 3 else None,
                         row[4] if len(row) > 4 else None,
                         row[5] if len(row) > 5 else None)
        b_s = str(b).strip() if b else ""
        d_s = str(d).strip() if d else ""
        # 节行：[core]
        import re
        m = re.match(r"^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$", d_s)
        if m:
            current_section = m.group(1)
            if b_s and b_s != "代码":
                yield ("section", m.group(1), b_s, None, None, None)
            continue
        # 字段行：B 列以英文+冒号结尾
        m2 = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*):$", b_s)
        if m2:
            yield ("code", m2.group(1), c.strip() if c else "", d_s,
                   str(e).strip() if e else "", str(f).strip() if f else "")
        # 带当前节的归属由调用方记录


def main():
    xlsx = sys.argv[1] if len(sys.argv) > 1 else r"W:\mao\tx\代码表1.15超强版(兼容)0830.xlsx"
    with open(CODE_JSON, encoding="utf-8") as fh:
        codes = json.load(fh)
    with open(TRANS_JSON, encoding="utf-8") as fh:
        trans = json.load(fh)

    existing_codes = {c.get("code") for c in codes.get("data", [])}
    trans_words = trans.get("words", [])
    existing_trans = {(t.get("en"), t.get("zh")) for t in trans_words}

    section_zh = {}
    new_codes = []
    new_trans = []
    current_section = ""
    for kind, key, zh, desc, demo, vtype in extract_rows(xlsx):
        if kind == "section":
            section_zh[key] = zh
            current_section = key
            if (key, zh) not in existing_trans and (key, zh) not in {(t["en"], t["zh"]) for t in new_trans}:
                new_trans.append({"en": key, "zh": zh})
            continue
        if kind == "code":
            if key in existing_codes:
                continue
            new_codes.append({
                "code": key,
                "translate": zh,
                "description": desc,
                "type": vtype,
                "addVersion": 0,
                "removeVersion": -1,
                "section": current_section,
                "demo": demo,
            })
            if zh and (key, zh) not in existing_trans and (key, zh) not in {(t["en"], t["zh"]) for t in new_trans}:
                new_trans.append({"en": key, "zh": zh})

    codes["data"].extend(new_codes)
    trans["words"].extend(new_trans)

    with open(CODE_JSON, "w", encoding="utf-8") as fh:
        json.dump(codes, fh, ensure_ascii=False, indent=1)
    with open(TRANS_JSON, "w", encoding="utf-8") as fh:
        json.dump(trans, fh, ensure_ascii=False, indent=1)

    print(f"追加字段 {len(new_codes)} 条（现有 {len(existing_codes)} → {len(codes['data'])}）")
    print(f"追加翻译对 {len(new_trans)} 条（现有 {len(existing_trans)} → {len(trans['words'])}）")
    print("节映射:", section_zh)


if __name__ == "__main__":
    main()
