# 阶段指令 — LOCATE（定位章节）

**当前任务**：在项目资料中定位用户指定的章节「{{target}}」。

步骤建议：
1. 先调用 `list_files` 了解项目里有哪些教材文件。
2. 对资料文件调用 `get_document_outline` 查看标题结构（如果文件较多，优先看预览判断哪本最相关）。
3. 调用 `find_section(file, target="{{target}}")` 精确定位。禁止猜测页码。
4. 若首次匹配失败：尝试其他文件、查看 `text_search_hits`、或用更精确/更宽松的章节名再试（最多再试 3 次）。

提交：调用 `submit_location` 提交最佳定位结果（file / heading / start_page / end_page / confidence）。
- 只有当你确信标题确实对应用户目标时才算定位成功；章节名模糊时选择最合理的候选并在 notes 说明理由。
- 若项目中所有文件都不包含该章节（例如用户要第 3 章但书只有 2 章），提交 `file="NOT_FOUND"`，并在 heading/notes 里说清楚原因——系统会把这当作任务失败并通知用户，这比胡乱定位更好。

完成后立即提交，不要做额外阅读。
