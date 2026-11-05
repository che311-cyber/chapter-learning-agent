"""验证统计只使用实际写回证据，不把修复描述当成已经修正。"""
from copy import deepcopy
import re


def summarize_verification(report, pool=None):
    if not report:
        return report
    out = deepcopy(report)
    issues = out.get("issues") or []
    questions = {str(q.get("id")): q for q in (pool or {}).get("questions", [])}
    remaining_applied = int(out.get("corrections_applied") or 0)
    for issue in issues:
        description = str(issue.get("fix_applied") or "")
        status = issue.get("resolution_status")
        if status == "corrected" and issue.get("applied") is True:
            pass
        elif re.search(r"无需(?:修正|修复|修改)|不需要(?:修正|修复)|无须", description):
            status = "no_change_needed"
        elif re.search(r"无法|未能|尚未|待修|不能.*修", description):
            status = "unresolved"
        elif (remaining_applied > 0 and isinstance(issue.get("corrected_question"), dict)
              and questions.get(str(issue["corrected_question"].get("id"))) == issue["corrected_question"]):
            status = "corrected"
            remaining_applied -= 1
        else:
            status = "unresolved"
        issue["resolution_status"] = status
    counts = {"found": len(issues), "corrected": 0, "unresolved": 0, "no_change_needed": 0}
    for issue in issues:
        counts[issue["resolution_status"]] += 1
    out["issue_counts"] = counts
    out["corrections_applied"] = counts["corrected"]
    if counts["unresolved"]:
        out["overall_pass"] = False
    return out
