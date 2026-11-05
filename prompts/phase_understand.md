# 阶段指令 — UNDERSTAND（生成章节临时理解）

**当前任务**：基于**已完整读取**的「{{heading}}」内容，生成本章结构化理解，调用 `submit_chapter_context` 提交。

要求：
- **一切内容必须有教材出处**（source_file + source_page）。这是防幻觉的核心机制：定义/定理逐条标注出处；找不到原文支持的"本章知识"一律不写。
- definitions：逐条提取本章定义（term / content / 出处）。content 用教材的表述（可轻度整理语言，不得改变数学含义）。
- theorems：本章的定理、性质、推论（name / content / 出处）。
- key_examples：本章最重要的例子（教材中的例子优先，注明页码）。
- skills：学完本章应会做的具体技能（如"验证一个运算是否满足交换律"）。
- common_mistakes / difficulty_points：基于教材内容与例题设置判断，不要泛泛而谈。
- prerequisites：本章依赖的前置概念（例如"映射"、"等价关系"）。若你为理解它们做过回溯检索，在 notes 提及检索到的位置。
- source_references：汇总主要出处（file + page + locator）。

这一层是**临时工作记忆**，不是永久知识库：目的是让后续方案设计稳定、可溯源。宁缺毋滥。

长章节也必须一次提交合法 JSON：只保留后续设计所需的核心定义、定理和代表例题，覆盖主要小节但不照抄整章证明或习题。definitions 至多10项、theorems 至多12项、key_examples 至多6项，各项内容以必要公式和适用条件为主，总输出控制在6000个汉字以内。若工具参数被截断，缩短每项内容及条目数后重交；本工具不支持分批累积。
