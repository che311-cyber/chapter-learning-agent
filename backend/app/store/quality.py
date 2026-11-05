"""旧成果的确定性复核：目录证据与阶段映射均保留出处。"""
from copy import deepcopy
import math
import re

AUDIT_VERSION = 1


def artifact_readable(name, data):
    """读取旧成果时检查容器类型，不把合法 JSON 中的损坏结构当成完整成果。"""
    if not isinstance(data, dict):
        return False
    required_lists = {"chapter_context": ("core_concepts", "definitions", "source_references"),
                      "learning_plan": ("learning_objectives", "learning_sequence"),
                      "question_pool": ("questions",)}.get(name, ())
    if any(not isinstance(data.get(key), list) or not data[key] for key in required_lists):
        return False
    collections = {
        "chapter_context": {"definitions": dict, "theorems": dict, "source_references": dict,
                            "core_concepts": str, "source_files": str},
        "learning_plan": {"learning_sequence": dict, "learning_objectives": str, "mastery_criteria": str},
        "question_pool": {"questions": dict},
        "verification": {"issues": dict},
    }.get(name, {})
    for key, kind in collections.items():
        if key in data and (not isinstance(data[key], list)
                            or any(not isinstance(item, kind) for item in data[key])):
            return False
    if name == "learning_plan":
        for stage in data.get("learning_sequence", []):
            if (type(stage.get("stage")) not in (int, str)
                    or not str(stage["stage"]).isdigit() or int(stage["stage"]) < 1):
                return False
            if any(key in stage and not isinstance(stage[key], str) for key in ("name", "goal", "psychology_note")):
                return False
            for key in ("content", "practice"):
                if key in stage and (not isinstance(stage[key], list)
                        or any(not isinstance(item, str) for item in stage[key])):
                    return False
    if name == "qa_report":
        from ..agent.schemas import QA_KEYS
        if any(not isinstance(data.get(key), dict) for key in QA_KEYS):
            return False
        if any(type(data[key].get("pass")) is not bool for key in QA_KEYS):
            return False
        if any(key in item and (not isinstance(item[key], list)
                or any(not isinstance(text, str) for text in item[key]))
                for item in (data[k] for k in QA_KEYS) for key in ("issues", "changes")):
            return False
    if name == "question_pool":
        ids = [q.get("id") for q in data["questions"]]
        if any(not isinstance(qid, str) or not qid.strip() for qid in ids) or len(ids) != len(set(ids)):
            return False
        for question in data["questions"]:
            if any(key in question and not isinstance(question[key], str)
                   for key in ("type", "prompt", "answer", "explanation", "learning_objective")):
                return False
            for key in ("source_basis", "options"):
                if question.get(key) is not None and (not isinstance(question[key], list)
                        or any(not isinstance(text, str) for text in question[key])):
                    return False
        if any(q.get("source_stage_index") is not None and not isinstance(q["source_stage_index"], (int, str))
               for q in data["questions"]):
            return False
    if name == "verification":
        if (type(data.get("re_solved")) is not bool or type(data.get("overall_pass")) is not bool
                or not isinstance(data.get("issues"), list)):
            return False
        try:
            int(data.get("corrections_applied") or 0)
        except (ValueError, TypeError, OverflowError):
            return False
    if name == "chapter_context":
        for key, fields in (("definitions", ("term", "content")), ("theorems", ("name", "content")),
                            ("key_examples", ("name", "content"))):
            items = data.get(key, [])
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                return False
            if any(field in item and not isinstance(item[field], str) for item in items for field in fields):
                return False
        for key in ("skills", "common_mistakes", "difficulty_points", "prerequisites"):
            if key in data and (not isinstance(data[key], list) or any(not isinstance(text, str) for text in data[key])):
                return False
    return True


def audit_source(state, context=None, verification=None):
    quality = deepcopy(state.get("quality")) if isinstance(state.get("quality"), dict) else {}
    for key in ("readableCoverage", "bodyContentCoverage", "rangeReadCoverage", "ocrConfidence", "pagesReadable", "pagesTotal"):
        value = quality.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0
                or ("Coverage" in key and value > 1)):
            quality.update(contentStatus="UNKNOWN", readableCoverage=0.0, sourceScope="UNKNOWN", requiresReview=True)
            quality[key] = 0
    definitions = (context or {}).get("definitions") or []
    markers = r"仅目录|仅(?:有|记录).*目录|目录层面|正文.{0,30}(?:不可读|无法读取|无法提取)|只能引用目录"
    # 使用成果自己的来源声明；一般提到目录不构成目录限定的证据。
    limited = sum(bool(re.search(markers, str(d.get("content", "")))) for d in definitions)
    notes = str((verification or {}).get("notes") or "")
    toc_only = (quality.get("sourceScope") == "TOC_ONLY"
                or quality.get("contentStatus") == "STRUCTURE_ONLY"
                or (definitions and limited == len(definitions))
                or "只能引用目录" in notes)
    if toc_only:
        quality.update(readableCoverage=0.0, bodyContentCoverage=0.0,
                       pagesReadable=0, sourceScope="TOC_ONLY", contentStatus="STRUCTURE_ONLY",
                       locationState="TOC_LOCATED", locationConfidence="low",
                       requiresReanalysis=True)
    elif not quality:
        quality.update(contentStatus="UNKNOWN", sourceScope="UNKNOWN", locationState="UNKNOWN")
    if toc_only or quality.get("sourceAuditVersion") != AUDIT_VERSION:
        quality["requiresReview"] = True
        quality["migrationVersion"] = AUDIT_VERSION
    return quality


def map_legacy_questions(plan, pool, verification=None):
    """仅迁移验证员明确记录的阶段→题号映射，禁止按题序轮分。"""
    out = deepcopy(pool or {})
    valid = {int(s["stage"]) for s in (plan or {}).get("learning_sequence", [])}
    notes = str((verification or {}).get("coverage_notes") or "")
    groups = re.findall(r"(?:阶段|stage)\s*(\d+)\s*([^；;。]*?)(?=(?:阶段|stage)\s*\d+|[；;。]|$)", notes, re.I)
    assignments = {}
    for stage, fragment in groups:
        stage = int(stage)
        if stage in valid:
            for qid in re.findall(r"\bq\d+\b", fragment, re.I):
                assignments.setdefault(qid, set()).add(stage)
    for question in out.get("questions", []):
        if question.get("stage_index") is not None:
            continue
        # source_stage_index 旧字段记录的是所属阶段，不等于综合题。
        source = question.get("source_stage_index")
        if isinstance(source, str) and source.isdigit():
            source = int(source)
        matches = assignments.get(str(question.get("id")), set())
        stage = source if source in valid else next(iter(matches)) if len(matches) == 1 else None
        if stage is not None:
            question["stage_index"] = stage
            question["stage_mapping_basis"] = "旧所属阶段字段" if source in valid else "verification.coverage_notes 明确题号映射"
    return out
