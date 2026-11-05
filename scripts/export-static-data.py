#!/usr/bin/env python3
"""把 projects/ 下已完成的章节分析成果导出为前端静态数据（frontend/public/static-data/）。

用法：./backend/venv/bin/python scripts/export-static-data.py [项目名，默认 abstract-algebra]
导出后运行 ./deploy-pages.sh 更新线上站点。
"""
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = sys.argv[1] if len(sys.argv) > 1 else "abstract-algebra"
pdir = ROOT / "projects" / PROJECT

if not pdir.exists():
    sys.exit(f"项目不存在: {pdir}")

bundles = []
ws_root = pdir / "workspace"
for ws in sorted(ws_root.iterdir()):
    if not ws.is_dir() or not (ws / "state.json").exists():
        continue
    state = json.loads((ws / "state.json").read_text(encoding="utf-8"))
    if state.get("status") != "COMPLETE":
        continue
    out = pdir / "output" / ws.name
    events = []
    ev_file = ws / "events.jsonl"
    if ev_file.exists():
        events = [json.loads(l) for l in ev_file.read_text(encoding="utf-8").splitlines()]

    def load(name):
        f = ws / name
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None

    result = {
        "run_id": ws.name,
        "status": state.get("status"),
        "target": state.get("target"),
        "located": state.get("located"),
        "chapter_context": load("chapter_context.json"),
        "learning_plan": load("learning_plan.json"),
        "question_pool": load("question_pool.json"),
        "qa_report": load("qa_report.json"),
        "verification": load("verification.json"),
        "markdown": {f.name: f.read_text(encoding="utf-8") for f in sorted(out.glob("*.md"))} if out.exists() else {},
        "files": {
            "workspace": [p.name for p in sorted(ws.glob("*")) if p.is_file()],
            "output": [p.name for p in sorted(out.glob("*")) if p.is_file()] if out.exists() else [],
        },
    }
    status = {
        "run_id": ws.name, "project": PROJECT, "target": state.get("target"),
        "phase": "COMPLETE", "running": False, "flags": state.get("flags", {}),
        "error": None, "located": state.get("located"),
        "events_total": events[-1]["seq"] if events else 0, "events": events,
    }
    bundles.append((ws.name, state, events, result, status))

if not bundles:
    sys.exit("没有已完成的章节可导出")

# 第一章优先作为演示章节
bundles.sort(key=lambda b: (b[0] != "第一章",))
name, _state, events, result, status = bundles[0]

files = []
inp = pdir / "input"
if inp.exists():
    for p in sorted(inp.iterdir()):
        if p.is_file():
            files.append({"name": p.name, "size": p.stat().st_size, "ext": p.suffix.lower(),
                          "pages": 3, "parse_ok": True, "mtime": int(p.stat().st_mtime)})

bundle = {
    "generated_at": date.today().isoformat(),
    "note": f"内置静态演示数据：{PROJECT} {name} 完整分析成果（DeepSeek Agent 真实运行产物）",
    "projects": [{"name": PROJECT, "file_count": len(files)}],
    "files": files,
    "runs": [{"slug": b[0], "target": b[4]["target"], "status": "COMPLETE",
              "updated_at": b[1].get("updated_at", 0), "error": None} for b in bundles],
    "status": status,
    "result": result,
}

dest = ROOT / "frontend" / "public" / "static-data" / f"{PROJECT}.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(bundle, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"已导出: {dest} ({dest.stat().st_size // 1024} KB)")
print(f"  章节: {[b[0] for b in bundles]}")
print(f"  题目 {len(result['question_pool']['questions'])} 题 | 事件 {len(events)} 条")
