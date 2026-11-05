#!/usr/bin/env python3
"""离线复核旧成果，默认预览；--apply 写回前逐文件备份，不调用模型。"""
import argparse
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import shutil
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import config
from app.agent.context import atomic_write_json
from app.agent.verification import summarize_verification
from app.store.quality import AUDIT_VERSION, audit_source, map_legacy_questions


def migrate(projects_dir, apply=False):
    backup = projects_dir.parent / "migration-backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    changes = []
    for state_file in sorted(projects_dir.glob("*/workspace/*/state.json")):
        ws = state_file.parent
        def load(name):
            p = ws / name
            return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
        state = load("state.json")
        if state.get("status") not in ("COMPLETE", "NEEDS_REVIEW", "INCOMPLETE"):
            continue  # 不触碰运行中任务或失败记录。
        context, plan, pool, verify = [load(n) for n in (
            "chapter_context.json", "learning_plan.json", "question_pool.json", "verification.json")]
        mapped_pool = map_legacy_questions(plan, pool, verify) if pool else None
        verified = summarize_verification(verify, mapped_pool)
        quality = audit_source(state, context, verified)
        # 原文目录页是直接证据，不依赖旧版本写入的 100% 覆盖率。
        if not quality.get("requiresReanalysis") and quality.get("sourceAuditVersion") != AUDIT_VERSION:
            loc = state.get("located") or {}
            path = ws.parents[1] / "input" / str(loc.get("file", ""))
            if path.is_file():
                from app.parsers.registry import get_document
                from app.parsers.base import is_toc_page
                doc = get_document(path)
                pages = [p for p in doc.pages if int(loc.get("start_page", 1)) <= p.index <= int(loc.get("end_page", 0))]
                if pages and all(is_toc_page(p.text) for p in pages):
                    quality = audit_source(dict(state, quality=dict(quality, sourceScope="TOC_ONLY")), context, verified)
        updated = deepcopy(state)
        updated["quality"] = quality
        review = load("review.json") or {"status": "draft"}
        if quality.get("requiresReview"):
            updated.setdefault("migration", {"version": AUDIT_VERSION, "previous_status": state.get("status"),
                                               "at": time.time()})
            updated["status"] = "NEEDS_REVIEW"
            if quality.get("requiresReanalysis"):
                updated.setdefault("flags", {}).update(chapter_read_complete=False, source_quality_ok=False)
            if review.get("status") in ("published", "approved"):
                review = deepcopy(review)
                review.setdefault("history", []).append({"status": "needs_review", "at": time.time(),
                                                         "reason": "旧成果正文质量复核"})
                review.update(status="needs_review", block_reasons=["旧成果正文质量复核；目录依据不能发布"],
                              updated_at=time.time())
        replacements = {"state.json": updated, "review.json": review}
        if mapped_pool is not None:
            replacements["question_pool.json"] = mapped_pool
        if verified is not None:
            replacements["verification.json"] = verified
        changed = [n for n, value in replacements.items() if load(n) != value]
        if not changed:
            continue
        if apply:
            for name in changed:
                source = ws / name
                destination = backup / source.relative_to(projects_dir)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if source.exists():
                    shutil.copy2(source, destination)
                atomic_write_json(source, replacements[name])
        changes.append({"project": ws.parents[1].name, "chapter": ws.name, "files": changed,
                        "status": updated["status"], "sourceScope": quality.get("sourceScope"),
                        "mapped_questions": sum(q.get("stage_index") is not None for q in (mapped_pool or {}).get("questions", [])),
                        "issue_counts": (verified or {}).get("issue_counts")})
    return {"applied": apply, "backup": str(backup) if apply and changes else None, "changes": changes}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--projects-dir", type=Path, default=config.PROJECTS_DIR)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(migrate(args.projects_dir, args.apply), ensure_ascii=False, indent=2))
