# 阶段指令 — READ（完整阅读目标章节）

**当前任务**：完整读取已定位的章节（文件：{{file}}，页码范围：第 {{start_page}} 页 至 第 {{end_page}} 页，标题「{{heading}}」）。

硬性要求：
1. 调用 `read_pages(file, start_page, end_page)` 开始读取。
2. 返回 `has_more=true` 时**必须**用 `offset=next_offset` 继续调用，直到 `has_more=false`。跳页、只读开头、读了大部分就提交，都会被系统拒绝。
3. 读取过程中若发现定位范围明显不对（比如内容与目标章节不符），可以重新 `find_section`，并以新结果为准重读。
4. 若正文出现本章无法自解释的前置概念（教材在别处定义），用 `search_local(query="概念名")` 定位后，**只读取该概念定义所在的页**（用 read_pages 指定该页，不要多读）。把每次回溯记入 backtracking_queries。

读取完成后，调用 `submit_reading(read_complete=true, outline_summary=…, backtracking_queries=…)`：
- outline_summary 概述：本章分几节、定义/定理/例题的分布、章末是否有习题。

**不要**在本阶段展开分析或设计——那是后续阶段的事。读完就提交。
