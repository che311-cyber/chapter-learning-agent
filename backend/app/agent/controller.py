"""分析控制器：把状态机、Agent Loop、工具、校验、持久化串成一次完整运行。

一个 Controller 实例 = 一个章节分析任务（可在后台线程运行、可恢复）。
"""
from __future__ import annotations

import json
from copy import deepcopy
import threading
from typing import Any, Dict, List, Optional

from .. import config
from ..parsers import registry as parser_registry
from ..services.deepseek import DeepSeekCancelled, DeepSeekClient, DeepSeekError
from . import render, schemas
from .verification import summarize_verification
from .context import RunContext, atomic_write_json, atomic_write_text, slugify
from .loop import PhaseError, PhaseRunner, RunCancelled
from .prompts import PHASE_PROMPTS, render as render_prompt
from .state_machine import (PHASES, PHASE_LABELS_ZH, build_state, load_state,
                            save_state, set_phase)

QA_KEYS = schemas.QA_KEYS


class LocateFailure(Exception):
    """Agent 确认无法定位目标章节。"""


class AnalysisController:
    def __init__(self, project: str, target: str, force: bool = False,
                 allowed_files: Optional[List[str]] = None):
        self.project = project
        self.target = target.strip()
        self.force = force
        self.slug = slugify(self.target)
        self.ctx = RunContext(project, self.target, self.slug, threading.Event())
        if allowed_files:
            self.ctx.allowed_files = list(allowed_files)
        self.ctx.source_versions = {
            p.name: [p.stat().st_mtime_ns, p.stat().st_size]
            for p in self.ctx.input_dir.glob("*")
            if p.is_file() and p.suffix.lower() in config.ALLOWED_UPLOAD_EXTS
            and (not allowed_files or p.name in allowed_files)
        }
        self.client = DeepSeekClient()
        self.model = self.client.model
        self.ctx.model = self.model
        self._qa_rounds = 0
        self._revision_this_qa_round = False
        self._verify_round = 0

    # ================================================================ 入口
    def run(self) -> None:
        ctx = self.ctx
        try:
            self._pipeline()
        except (RunCancelled, DeepSeekCancelled):
            ctx.resume_phase = ctx.phase if ctx.phase in PHASES[:-1] else None
            ctx.phase = "CANCELLED"
            ctx.error = "任务已被用户取消"
            ctx.emit("任务已取消", level="warning")
        except LocateFailure as e:
            ctx.phase = "FAILED"
            ctx.error = f"无法定位章节「{self.target}」：{e}"
            ctx.emit(ctx.error, level="error")
        except DeepSeekError as e:
            ctx.resume_phase = ctx.phase if not e.fatal and ctx.phase in PHASES[:-1] else None
            ctx.phase = "FAILED"
            ctx.error = str(e)
            if ctx.resume_phase:
                ctx.error += "；进度已保存，可点击「开始分析」继续"
            ctx.emit(f"模型调用失败：{e}", level="error")
        except PhaseError as e:
            ctx.phase = "FAILED"
            ctx.error = str(e)
            ctx.emit(str(e), level="error")
        except Exception as e:  # noqa: BLE001 - 任何未预期异常都不应让后端崩溃
            ctx.phase = "FAILED"
            ctx.error = f"内部错误（{type(e).__name__}）：{e}"
            ctx.emit(ctx.error, level="error")
        finally:
            save_state(ctx)
            ctx.save_messages()

    # ================================================================ 状态机主干
    def _pipeline(self) -> None:
        ctx = self.ctx
        ctx.workspace_dir.mkdir(parents=True, exist_ok=True)
        ctx.output_dir.mkdir(parents=True, exist_ok=True)

        saved = None if self.force else load_state(ctx)
        if saved and saved.get("resume_phase") in PHASES[:-1]:
            saved = dict(saved, status=saved["resume_phase"])
        resumable = (saved and saved.get("status") in PHASES
                     and saved.get("status") not in ("COMPLETE", "FAILED", "CANCELLED"))

        if resumable:
            self._restore_from(saved)
            ctx.emit(f"检测到未完成任务，从阶段 {ctx.phase} 继续", level="info")
            # 提交已成功落盘、但尚未来得及切换阶段时，不重复生成或再次追加同一批题。
            checkpoints = {
                "LOCATE": ("source_located", bool(ctx.located)),
                "READ": ("chapter_read_complete", bool(ctx.artifacts.get("quality"))),
                "UNDERSTAND": ("understanding_complete", bool(ctx.artifacts.get("context"))),
                "DESIGN": ("design_complete", bool(ctx.artifacts.get("plan"))),
                "GENERATE": ("questions_complete", bool(ctx.artifacts.get("pool"))),
            }
            checkpoint = checkpoints.get(ctx.phase)
            if checkpoint and ctx.flags.get(checkpoint[0]) and checkpoint[1]:
                set_phase(ctx, PHASES[PHASES.index(ctx.phase) + 1])
        else:
            # 全新开始（首次/上轮失败后重跑/force 重跑）：清掉上一轮的运行痕迹，
            # 避免 events.jsonl 追加导致 seq 重复、旧产物与新运行混杂。
            self._clean_workspace()
            set_phase(ctx, "TARGET")

        if ctx.phase == "TARGET":
            self._phase_target()
            set_phase(ctx, "LOCATE")

        phase_prompt_vars = {"target": self.target, "project": self.project,
                             "slug": self.slug, "file": "", "start_page": "",
                             "end_page": "", "heading": ""}

        while ctx.phase not in ("COMPLETE", "FAILED", "CANCELLED"):
            phase = ctx.phase
            if phase not in PHASE_PROMPTS:
                # SAVE / 未知阶段：本地处理
                if phase == "SAVE":
                    self._phase_save()
                    set_phase(ctx, "COMPLETE")
                    continue
                break

            if phase == "LOCATE":
                self._require_input_files()
                phase_prompt_vars.update({})
                kickoff = (f"请开始定位章节「{self.target}」。"
                           f"先用 list_files 查看项目资料（projects/{self.project}/input/）。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("source_located"):
                    raise PhaseError("LOCATE 阶段未成功提交定位结果")
                set_phase(ctx, "READ")

            elif phase == "READ":
                loc = ctx.located or {}
                phase_prompt_vars.update({"file": loc.get("file", ""),
                                          "start_page": loc.get("start_page"),
                                          "end_page": loc.get("end_page"),
                                          "heading": loc.get("heading", "")})
                kickoff = (f"请完整读取 {loc.get('file')} 第 {loc.get('start_page')}–"
                           f"{loc.get('end_page')} 页（「{loc.get('heading')}」）。"
                           f"用 read_pages 读取，has_more=true 时必须用 next_offset 续读。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("chapter_read_complete"):
                    raise PhaseError("READ 阶段未确认完整读取")
                set_phase(ctx, "UNDERSTAND")

            elif phase == "UNDERSTAND":
                kickoff = ("请基于已读取的章节内容，用 submit_chapter_context 提交本章结构化理解。"
                           "所有定义/定理必须带教材出处（文件+页码）。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("understanding_complete"):
                    raise PhaseError("UNDERSTAND 阶段未提交章节理解")
                cc = ctx.artifacts.get("context") or {}
                ctx.emit(f"章节理解完成：{len(cc.get('core_concepts', []))} 个核心概念、"
                         f"{len(cc.get('definitions', []))} 个定义、{len(cc.get('theorems', []))} 个定理",
                         level="success")
                set_phase(ctx, "DESIGN")

            elif phase == "DESIGN":
                kickoff = ("请切换为学习设计师：基于 chapter_context 与教材原文，"
                           "用 submit_learning_plan 提交本章学习方案。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("design_complete"):
                    raise PhaseError("DESIGN 阶段未提交学习方案")
                set_phase(ctx, "GENERATE")

            elif phase == "GENERATE":
                kickoff = ("请基于 chapter_context、learning_plan 与教材原文出题，"
                           "用 submit_question_pool 提交（可分批，最后一批 is_final=true）。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("questions_complete"):
                    raise PhaseError("GENERATE 阶段未完成题库提交")
                pool = ctx.artifacts.get("pool") or {}
                ctx.emit(f"练习生成完成：共 {len(pool.get('questions', []))} 道题", level="success")
                set_phase(ctx, "PSYCHOLOGY_CHECK")

            elif phase == "PSYCHOLOGY_CHECK":
                kickoff = ("请切换为独立 QA 审查员：读取 learning_plan.json 与 question_pool.json，"
                           "按 7 条学习心理学原则逐条检查（read_file 读取，用 submit_qa_report 提交）。"
                           "pass=false 的条目必须先修订方案/题库（revision 提交）再复查。")
                self._start_llm_phase(phase, phase_prompt_vars, kickoff)
                if not ctx.flags.get("psychology_check_complete"):
                    raise PhaseError("PSYCHOLOGY_CHECK 阶段未完成")
                set_phase(ctx, "VERIFY")

            elif phase == "VERIFY":
                self._phase_verify(phase_prompt_vars)
                if not ctx.flags.get("verification_complete"):
                    raise PhaseError("VERIFY 阶段未完成")
                set_phase(ctx, "SAVE")

            elif phase == "SAVE":
                self._phase_save()
                set_phase(ctx, "COMPLETE")

    # ================================================================ 各阶段
    def _clean_workspace(self) -> None:
        """全新开始前清理上一轮运行文件（都是可再生产物，input/ 绝不触碰）。"""
        ctx = self.ctx
        for name in ("events.jsonl", "messages.json", "state.json",
                     "chapter_context.json", "learning_plan.json",
                     "question_pool.json", "qa_report.json", "verification.json"):
            f = ctx.workspace_dir / name
            try:
                if f.exists():
                    f.unlink()
            except OSError:
                pass
        for name in ("learning_plan.md", "questions.md", "final_report.md"):
            (ctx.output_dir / name).unlink(missing_ok=True)

    def _phase_target(self) -> None:
        ctx = self.ctx
        ctx.emit(f"任务开始：分析「{self.target}」（项目 {self.project}）", level="info")
        files = self._require_input_files()
        ctx.emit(f"已读取项目资料：{len(files)} 个教材文件", level="success")
        # 扫描版预警：文字层稀疏的 PDF 内容深度会受限
        limited = getattr(ctx, "allowed_files", None)
        for p in files:
            if limited and p.name not in limited:
                continue
            try:
                doc = parser_registry.get_document(p)
            except Exception:  # noqa: BLE001
                continue
            if getattr(doc, "scan_suspect", False):
                ctx.emit(f"⚠️ {p.name} 的文字层稀疏（平均每页 {getattr(doc, 'text_density', 0):.0f} 字符），"
                         "疑似扫描版：正文细节可能无法提取，分析深度将受限。"
                         "建议提供文字版 PDF，或先自行 OCR。", level="warning")

    def _require_input_files(self) -> List[Any]:
        ctx = self.ctx
        if not ctx.input_dir.exists():
            raise PhaseError(f"项目 {self.project} 的 input/ 目录不存在。请先上传教材文件。")
        files = [p for p in sorted(ctx.input_dir.iterdir())
                 if p.is_file() and p.suffix.lower() in
                 {".pdf", ".txt", ".md", ".markdown", ".docx", ".pptx"}]
        if not files:
            raise PhaseError(f"项目 {self.project} 的 input/ 目录为空：请先放入教材（PDF/TXT/MD/DOCX/PPTX）再分析。")
        return files

    def _start_llm_phase(self, phase: str, vars_: Dict[str, Any], kickoff: str) -> None:
        ctx = self.ctx
        set_phase(ctx, phase)
        vars_ = dict(vars_)
        if phase == "PSYCHOLOGY_CHECK":
            self._qa_rounds = 0
            self._revision_this_qa_round = False
        if phase == "VERIFY":
            self._verify_round = 0

        system = render_prompt("chapter_agent_system", target=self.target, project=self.project)
        prompt_name = PHASE_PROMPTS[phase]
        phase_doc = render_prompt(prompt_name, **vars_)
        runner = PhaseRunner(ctx, self.client, self._submit_callback,
                             on_tool=self._on_tool)
        ctx._current_runner = runner
        runner.run(system + "\n\n---\n\n" + phase_doc, kickoff)

    # ---------------------------------------------------------------- VERIFY（多轮）
    def _phase_verify(self, vars_: Dict[str, Any]) -> None:
        ctx = self.ctx
        while True:
            set_phase(ctx, "VERIFY")
            vars_ = dict(vars_)
            system = render_prompt("chapter_agent_system", target=self.target, project=self.project)
            phase_doc = render_prompt("verification", **vars_)
            kickoff = ("请读取 learning_plan.json 与 question_pool.json 并执行最终验证："
                       "逐题独立重新解题，核对答案/解析/覆盖/难度。"
                       "用 submit_verification 提交验证报告。")
            if self._verify_round > 0:
                kickoff = ("上一轮验证发现的问题已修正并写回 question_pool.json。"
                           "请对修正后的题库再次执行独立验证（重新解题核对），"
                           "用 submit_verification 提交复查报告。")
            runner = PhaseRunner(ctx, self.client, self._submit_callback,
                                 on_tool=self._on_tool)
            ctx._current_runner = runner
            runner.run(system + "\n\n---\n\n" + phase_doc, kickoff)

            applied = ctx.artifacts.get("_verify_corrections", 0)
            verify = ctx.artifacts.get("verify") or {}
            if (self._verify_round + 1) < config.MAX_VERIFY_ROUNDS and applied > 0:
                self._verify_round += 1
                ctx.emit(f"已应用 {applied} 处修正，进入第 {self._verify_round + 1} 轮复查", level="info")
                continue
            ctx.flags["verification_complete"] = True
            save_state(ctx)
            ctx.emit(f"独立验证完成：{'通过' if verify.get('overall_pass') else '发现遗留问题（见报告）'}",
                     level="success")
            return

    # ---------------------------------------------------------------- SAVE
    def _phase_save(self) -> None:
        ctx = self.ctx
        ctx.emit("正在保存全部结果……", level="info")
        context = ctx.artifacts.get("context") or {}
        plan = ctx.artifacts.get("plan") or {}
        pool = ctx.artifacts.get("pool") or {}
        qa = ctx.artifacts.get("qa") or {}
        verify = ctx.artifacts.get("verify") or {}

        atomic_write_json(ctx.workspace_dir / "chapter_context.json", context)
        atomic_write_json(ctx.workspace_dir / "learning_plan.json", plan)
        atomic_write_json(ctx.workspace_dir / "question_pool.json", pool)
        atomic_write_json(ctx.workspace_dir / "qa_report.json", qa)
        if verify:
            atomic_write_json(ctx.workspace_dir / "verification.json", verify)
        state = build_state(ctx)
        state["model"] = self.model
        atomic_write_json(ctx.workspace_dir / "state.json", state)

        ctx.output_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(ctx.output_dir / "learning_plan.md", render.render_learning_plan(plan))
        atomic_write_text(ctx.output_dir / "questions.md", render.render_questions(pool))
        atomic_write_text(ctx.output_dir / "final_report.md",
                          render.render_final_report(ctx, context, plan, pool, qa, verify, state))

        ctx.emit(f"全部结果已保存：workspace/{self.slug}/ 与 output/{self.slug}/", level="success")

    # ================================================================ 提交回调
    def _submit_callback(self, name: str, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        handler = {
            "submit_location": self._on_submit_location,
            "submit_reading": self._on_submit_reading,
            "submit_chapter_context": self._on_submit_context,
            "submit_learning_plan": self._on_submit_plan,
            "submit_question_pool": self._on_submit_pool,
            "submit_qa_report": self._on_submit_qa,
            "submit_verification": self._on_submit_verify,
        }.get(name)
        if handler is None:
            return f"SUBMIT_REJECTED: 未知提交工具 {name}"
        try:
            msg = handler(args)
        except (LocateFailure, PhaseError):
            raise  # 定位失败 = 任务失败，直接终止运行
        except Exception as e:  # noqa: BLE001
            return f"SUBMIT_REJECTED: 提交处理异常（{type(e).__name__}: {e}），请修正后重试"
        ctx.save_messages()
        save_state(ctx)
        return msg or "SUBMIT_ACCEPTED"

    def _set_accepted(self, runner_flag: str, tool: str, args: Dict[str, Any]) -> None:
        # PhaseRunner 通过检查 self.accepted 判断阶段完成；
        # 这里通过 ctx 上挂的当前 runner 引用设置。
        runner = getattr(self.ctx, "_current_runner", None)
        if runner is not None:
            runner.accepted = {"tool": tool, "args": args}


    # ---- LOCATE
    def _on_submit_location(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        if str(args.get("file", "")).upper() == "NOT_FOUND":
            from ..tools.document_tools import find_section
            for path in self._require_input_files():
                if ctx.allowed_files and path.name not in ctx.allowed_files:
                    continue
                evidence = find_section(ctx, {"file": path.name, "target": self.target})
                if evidence.get("locationState") == "BODY_LOCATED":
                    return "SUBMIT_REJECTED: 正文中已找到目标，请提交 find_section 返回的文件和范围，不能报 NOT_FOUND。"
            reason = str(args.get("notes") or args.get("heading") or "Agent 在项目资料中未找到该章节")
            raise LocateFailure(reason)
        errors = schemas.validate_location(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors)
        file = args["file"]
        path = ctx.input_dir / file
        if not path.is_file():
            return f"SUBMIT_REJECTED: 文件 {file} 不在 input/ 中，请用 list_files 确认文件名"
        try:
            doc = parser_registry.get_document(path)
        except Exception as e:  # noqa: BLE001
            return f"SUBMIT_REJECTED: 文件解析失败（{e}），请换一个文件或报告该文件不可用"
        sp, ep = int(args["start_page"]), int(args["end_page"])
        if ep > doc.total_pages or sp < 1:
            return (f"SUBMIT_REJECTED: 页码范围 {sp}–{ep} 超出文档范围"
                    f"（{doc.name} 共 {doc.total_pages} 页）。禁止猜测页码。")
        # 复用工具的正文/普通标题证据，并核验提交范围，不能只看全书最高标题分。
        from ..tools.document_tools import find_section
        evidence = find_section(ctx, {"file": file, "target": self.target})
        candidates = evidence.get("candidates", [])
        selected = next((c for c in candidates if sp <= c["start_page"] <= ep), None)
        if not selected:
            return (f"SUBMIT_REJECTED: 范围 P{sp}–P{ep} 内没有目标「{self.target}」的定位证据。"
                    "请使用 find_section 返回的正文范围，不能猜测页码。")
        if evidence.get("locationState") == "BODY_LOCATED" and (
                sp != selected["start_page"] or ep != selected["end_page"]):
            return "SUBMIT_REJECTED: 提交范围与已核验正文边界不一致，请使用 find_section 的完整范围。"
        ctx.located = {"file": file, "heading": selected["title"],
                       "start_page": sp, "end_page": ep,
                       "confidence": evidence.get("locationConfidence", "low"),
                       "locationConfidence": evidence.get("locationConfidence", "low"),
                       "locationState": evidence.get("locationState", "UNKNOWN"),
                       "notes": args.get("notes", "")}
        ctx.flags["source_located"] = True
        self._set_accepted("locate", "submit_location", args)
        ctx.emit(f"已定位「{args.get('heading', self.target)}」：{file} "
                 f"P{sp}–P{ep}（共 {ep - sp + 1} 页）", level="success")
        return f"SUBMIT_ACCEPTED: 定位结果已记录。下一阶段将完整读取 P{sp}–P{ep}。"

    # ---- READ
    def _readable_coverage(self, loc):
        """正文可读质量：范围内有实质文本（原文字层或 OCR）的页占比、OCR 置信度。"""
        file = loc.get("file", "")
        path = self.ctx.input_dir / file
        try:
            doc = parser_registry.get_document(path)
        except Exception:
            return {"readableCoverage": 0.0, "ocrConfidence": None, "pagesTotal": 0, "pagesReadable": 0}
        start, end = int(loc.get("start_page", 1)), int(loc.get("end_page", 1))
        try:
            from ..parsers import registry as reg
            ocr_cache = reg.get_ocr_cache(str(path.resolve()))
        except Exception:
            ocr_cache = {}
        total = readable = 0
        confs = []
        for p in doc.pages:
            if not (start <= p.index <= end):
                continue
            total += 1
            p_eff = ocr_cache.get(p.index, p)
            txt = getattr(p_eff, "text", "") or ""
            from ..parsers.base import is_toc_page
            if (len(txt.strip()) >= 120 and not is_toc_page(txt)
                    and not getattr(p_eff, "ocr_failed", False)
                    and (p_eff.ocr_confidence is None or p_eff.ocr_confidence >= 60)):
                readable += 1
            conf = getattr(p_eff, "ocr_confidence", None)
            if conf is not None:
                confs.append(conf)
        cov = round(readable / total, 2) if total else 0.0
        return {"readableCoverage": cov, "pagesTotal": total, "pagesReadable": readable,
                "ocrConfidence": round(sum(confs) / len(confs), 1) if confs else None,
                "locationConfidence": (loc.get("locationConfidence") or loc.get("confidence") or "medium"),
                "locationState": (loc.get("locationState") or "UNKNOWN")}

    # ---- READ
    def _on_submit_reading(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        errors = schemas.validate_reading(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors)
        loc = ctx.located or {}
        cov = ctx.coverage_of(loc.get("file", ""), int(loc.get("start_page", 1)),
                              int(loc.get("end_page", 1)))
        if cov["read"] < cov["total"]:
            return ("SUBMIT_REJECTED: 章节尚未完整读取："
                    f"已完整阅读 {cov['read']}/{cov['total']} 页，"
                    f"未读页：{cov['missing_pages'][:20]}。"
                    "请继续用 read_pages(file, start, end, offset=next_offset) 续读，直到 has_more=false。")
        # 正文可读质量门控：扫描版正文覆盖率不足时诚实标注，不宣称"完整阅读完成"
        quality = self._readable_coverage(loc)

        # ---- 目录页检测与分类 ----
        from ..parsers.base import is_toc_page
        _doc_path = ctx.input_dir / loc.get("file", "")
        try:
            _doc = parser_registry.get_document(_doc_path)
        except Exception:
            _doc = None
        start_pg = int(loc.get("start_page", 1))
        end_pg = int(loc.get("end_page", 1))
        toc_n, body_n = 0, 0
        for _pg in (_doc.pages if _doc else []):
            if not (start_pg <= _pg.index <= end_pg):
                continue
            _eff = parser_registry.get_ocr_cache(str(_doc_path.resolve())).get(_pg.index, _pg)
            if is_toc_page(_eff.text):
                toc_n += 1
            elif (len(_eff.text.strip()) >= 120 and not _eff.ocr_failed
                  and (_eff.ocr_confidence is None or _eff.ocr_confidence >= 60)):
                body_n += 1
        _total_in_range = end_pg - start_pg + 1

        if toc_n > 0 and body_n == 0:
            source_scope = "TOC_ONLY"
            content_status = "STRUCTURE_ONLY"
            body_content_coverage = 0.0
        elif _total_in_range > 0 and body_n > 0:
            _ratio = body_n / _total_in_range
            source_scope = "FULL_BODY" if _ratio == 1.0 else "PARTIAL_BODY"
            content_status = "CONTENT_READY" if _ratio >= 0.8 and quality.get("readableCoverage", 0) >= 0.6 else "PARTIAL_CONTENT"
            body_content_coverage = round(_ratio, 2)
        else:
            source_scope = "UNKNOWN"
            content_status = "UNKNOWN"
            body_content_coverage = None

        quality["sourceScope"] = source_scope
        quality["contentStatus"] = content_status
        quality["bodyContentCoverage"] = body_content_coverage
        quality["rangeReadCoverage"] = round(cov["read"] / max(1, cov["total"]), 2) if cov["total"] else 0
        quality["toc_pages"] = toc_n
        quality["body_pages"] = body_n
        ctx.artifacts["quality"] = quality

        # OCR 定位必须在 LOCATE 阶段完成。目录读取不能让生成流程提前继续。
        if source_scope == "TOC_ONLY":
            quality["locationState"] = "TOC_LOCATED"
            quality["readableCoverage"] = 0.0
            ctx.flags["chapter_read_complete"] = False
            ctx.flags["source_quality_ok"] = False
            save_state(ctx)
            raise PhaseError("仅定位并读取到目录，正文尚未读取。请通过 find_section 的 OCR 正文搜索重新定位；禁止据目录生成教学内容。")

        # ---- 门控 2：覆盖率不足 ----
        if quality["readableCoverage"] < 0.6:
            ctx.flags["chapter_read_complete"] = False
            ctx.flags["source_quality_ok"] = False
            quality["locationState"] = "READING_LIMITED"
            save_state(ctx)
            return ("SUBMIT_REJECTED: 正文不可靠读取——"
                    f"可读取内容覆盖率仅 {int(quality['readableCoverage'] * 100)}%"
                    f"（{quality['pagesReadable']}/{quality['pagesTotal']} 页有实质文字层）"
                    + (f"，OCR 置信度 {quality['ocrConfidence']}" if quality.get("ocrConfidence") else "")
                    + "。该教材疑似扫描版且 OCR 未就绪/失败：需要 OCR、补充文字版教材或教师确认。"
                      "禁止在正文不可读的情况下生成本章内容。")
        quality["locationState"] = "BODY_READ"
        ctx.flags["chapter_read_complete"] = True
        ctx.flags["source_quality_ok"] = True
        ctx.artifacts["reading"] = {
            "outline_summary": args.get("outline_summary", ""),
            "backtracking_queries": args.get("backtracking_queries", []),
        }
        save_state(ctx)
        quality["sourceAuditVersion"] = 1
        self._set_accepted("reading", "submit_reading", args)
        ctx.emit(f"章节读取完成（正文覆盖率 {int(quality['readableCoverage'] * 100)}%"
                 + (f"，OCR 置信度 {quality['ocrConfidence']}" if quality.get("ocrConfidence") else "")
                 + "）", level="success")
        return "SUBMIT_ACCEPTED: 阅读完整性校验通过。"


    # ---- UNDERSTAND
    def _on_submit_context(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        errors = schemas.validate_chapter_context(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors[:8])
        available = {p.name for p in self._require_input_files()
                     if ctx.allowed_files is None or p.name in ctx.allowed_files}
        if any(name not in available for name in args["source_files"]):
            return "SUBMIT_REJECTED: source_files 只能引用本次检索范围内的实际教材文件。"
        for ref in args["source_references"] + args["definitions"] + args["theorems"]:
            filename = ref.get("file") or ref.get("source_file")
            if filename is None:
                continue
            if not isinstance(filename, str) or filename not in available:
                return "SUBMIT_REJECTED: 内容出处包含不存在或超出本次检索范围的文件。"
            page = ref.get("page", ref.get("source_page"))
            if page is not None and (type(page) is not int or page < 1
                    or page > parser_registry.get_document(ctx.input_dir / filename).total_pages):
                return "SUBMIT_REJECTED: 教材出处页码不合法，请使用实际阅读返回的页码。"
        ctx.artifacts["context"] = args
        ctx.flags["understanding_complete"] = True
        atomic_write_json(ctx.workspace_dir / "chapter_context.json", args)
        self._set_accepted("context", "submit_chapter_context", args)
        return (f"SUBMIT_ACCEPTED: 章节理解已保存（{len(args.get('core_concepts', []))} 概念 / "
                f"{len(args.get('definitions', []))} 定义）。")

    # ---- DESIGN
    def _on_submit_plan(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        errors = schemas.validate_learning_plan(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors[:8])
        ctx.artifacts["plan"] = args
        ctx.flags["design_complete"] = True
        atomic_write_json(ctx.workspace_dir / "learning_plan.json", args)
        if ctx.phase == "PSYCHOLOGY_CHECK":
            self._revision_this_qa_round = True
            ctx.emit("QA 修订：学习方案已更新", level="info")
            # 修订不结束当前阶段——QA 阶段以 submit_qa_report 收尾
            return "REVISION_ACCEPTED: 修订后的学习方案已保存。请继续完成 QA 检查流程。"
        ctx.emit(f"学习方案已生成：{len(args.get('learning_sequence', []))} 个学习阶段", level="success")
        self._set_accepted("plan", "submit_learning_plan", args)
        return "SUBMIT_ACCEPTED: 学习方案已保存。"

    # ---- GENERATE
    def _on_submit_pool(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        is_final = bool(args.get("is_final"))
        revision = bool(args.get("revision")) or ctx.phase == "PSYCHOLOGY_CHECK"
        batch = args.get("questions")
        if not isinstance(batch, list) or not batch:
            return "SUBMIT_REJECTED: questions 必须是非空数组"

        errors = []
        existing = ctx.artifacts.get("pool") or {"chapter": args.get("chapter", ""), "questions": []}
        continuing_revision = (revision and int(args.get("batch_index") or 1) > 1
                               and existing.get("final") is False)
        if revision and not continuing_revision:
            merged: List[Dict] = []
        else:
            merged = list(existing.get("questions", []))
        ids = {str(q.get("id")) for q in merged}
        for q in batch:
            sub: List[str] = []
            schemas.validate_question(q, 0, sub, set())
            if sub:
                errors.extend(sub)
                continue
            qid = str(q.get("id"))
            if qid in ids:
                errors.append(f"题目 id 与已有题库重复: {qid}（请换 id 或使用 revision 全量替换）")
                continue
            ids.add(qid)
            merged.append(q)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors[:8])

        if is_final:
            if len(merged) < 5:
                return (f"SUBMIT_REJECTED: 最终题库仅 {len(merged)} 题，至少需要 5 题。"
                        "请继续出题后再提交 is_final=true。")
            diffs = {int(q.get("difficulty")) for q in merged}
            if 1 not in diffs:
                return "SUBMIT_REJECTED: 缺少基础题（difficulty=1），请补充后再提交。"
            if not (2 in diffs or 3 in diffs):
                return "SUBMIT_REJECTED: 全部是基础题，缺少中高难度（difficulty≥2），请补充。"

        # 阶段四一致性校验：stage_index 必须落在 learning_plan 的阶段集合内
        plan = ctx.artifacts.get("plan") or {}
        objectives = {str(o).strip() for o in plan.get("learning_objectives", [])}
        if objectives:
            bad = [str(q.get("id")) for q in batch
                   if str(q.get("learning_objective", "")).strip() not in objectives]
            if bad:
                return (f"SUBMIT_REJECTED: 题目 {bad[:5]} 的 learning_objective 必须逐字复制"
                        " learning_plan.learning_objectives 中的一项，不能改写成简称。")
            if is_final:
                covered = {str(q.get("learning_objective", "")).strip() for q in merged}
                if objectives - covered:
                    return "SUBMIT_REJECTED: 最终题库尚未覆盖全部 learning_objectives，请补齐目标对应题目。"
        valid_stages = {int(x.get("stage")) for x in plan.get("learning_sequence", []) if x.get("stage") is not None}
        if valid_stages:
            bad = [str(q.get("id")) for q in batch
                   if q.get("stage_index") is not None and int(q.get("stage_index")) not in valid_stages]
            if bad:
                return (f"SUBMIT_REJECTED: 题目 {bad[:5]} 的 stage_index 不在学习方案阶段集合 {sorted(valid_stages)} 内，"
                        "请修正归属后重新提交。")
            for q in batch:
                if q.get("stage_index") is None:
                    return ("SUBMIT_REJECTED: 题目 " + str(q.get("id"))
                            + " 缺少 stage_index（所属学习阶段），请按 learning_plan 标注后重新提交。")
            if is_final and valid_stages - {int(q["stage_index"]) for q in merged}:
                return "SUBMIT_REJECTED: 最终题库存在没有练习题的学习阶段，请补齐阶段练习。"

        pool = {"chapter": args.get("chapter", existing.get("chapter", "")),
                "questions": merged, "batches": (existing.get("batches", 0)) + 1,
                "final": is_final}
        ctx.artifacts["pool"] = pool
        atomic_write_json(ctx.workspace_dir / "question_pool.json", pool)

        if ctx.phase == "PSYCHOLOGY_CHECK":
            # QA 修订：记录修订，不结束阶段（QA 阶段以 submit_qa_report 收尾）
            self._revision_this_qa_round = True
            ctx.emit(f"QA 修订：题库已更新（现 {len(merged)} 题）", level="info")
            return (f"REVISION_ACCEPTED: 修订后题库已保存（现 {len(merged)} 题）。"
                    "请继续完成 QA 检查流程。")

        if is_final:
            ctx.flags["questions_complete"] = True
            ctx.emit(f"练习生成完成：共 {len(merged)} 题", level="success")
            self._set_accepted("pool", "submit_question_pool", args)
            return f"SUBMIT_ACCEPTED: 题库已定稿（共 {len(merged)} 题）。"
        ctx.emit(f"练习批次 {pool['batches']} 已提交：累计 {len(merged)} 题", level="info")
        return (f"BATCH_ACCEPTED: 当前累计 {len(merged)} 题（尚未定稿）。"
                "请继续提交下一批，全部完成后以 is_final=true 提交最后一批。")

    # ---- PSYCHOLOGY_CHECK
    def _on_submit_qa(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        if (ctx.artifacts.get("pool") or {}).get("final") is False:
            return "SUBMIT_REJECTED: 分批修订的题库尚未定稿，请补齐全部阶段和目标后以 is_final=true 提交。"
        errors = schemas.validate_qa_report(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors[:8])
        all_pass = schemas.qa_all_pass(args)
        self._qa_rounds += 1
        if not all_pass:
            if not self._revision_this_qa_round:
                if self._qa_rounds < config.MAX_QA_REVISION_ROUNDS:
                    failed = [k for k in QA_KEYS if not args.get(k, {}).get("pass")]
                    return ("SUBMIT_REJECTED: 存在 pass=false 的原则（" +
                            ", ".join(failed) +
                            "），但本轮没有提交任何修订。请先修改 learning_plan / question_pool"
                            "（revision 提交），再重新提交完整 QA 报告。")
                # 修订轮次上限：接受但明确标注
                ctx.artifacts["qa"] = args
                ctx.artifacts["qa_round_limit_reached"] = True
                ctx.flags["psychology_check_complete"] = True
                atomic_write_json(ctx.workspace_dir / "qa_report.json", args)
                ctx.emit(f"心理学检查达到修订轮次上限（{config.MAX_QA_REVISION_ROUNDS}），"
                         "以当前状态定稿（含未完全通过项）", level="warning")
                self._set_accepted("qa", "submit_qa_report", args)
                return "SUBMIT_ACCEPTED: 达到修订轮次上限，QA 报告已定稿（含未通过项，将写入最终报告）。"
            # 有修订：重置本轮修订标记，要求继续复查
            self._revision_this_qa_round = False
            failed = [k for k in QA_KEYS if not args.get(k, {}).get("pass")]
            return ("SUBMIT_REJECTED: 修订已记录，但仍有未通过项（" +
                    ", ".join(failed) +
                    "）。请针对这些项继续修订（如需要），然后重新提交复查后的完整 QA 报告；"
                    "若某原则因课程性质只能部分应用，可设 pass=true + partial=true + justification。")

        ctx.artifacts["qa"] = args
        ctx.flags["psychology_check_complete"] = True
        atomic_write_json(ctx.workspace_dir / "qa_report.json", args)
        qa_status = schemas.qa_report_status(args)
        ctx.emit("7 条心理学原则检查：" + ("全部通过" if qa_status == "PASS" else "部分通过，需教师复核"),
                 level="success" if qa_status == "PASS" else "warning")
        self._set_accepted("qa", "submit_qa_report", args)
        return ("SUBMIT_ACCEPTED: 7 条原则检查全部通过。" if qa_status == "PASS" else
                "SUBMIT_ACCEPTED: 7 条原则检查部分通过，需教师复核。")

    # ---- VERIFY
    def _on_submit_verify(self, args: Dict[str, Any]) -> str:
        ctx = self.ctx
        errors = schemas.validate_verification(args)
        if errors:
            return "SUBMIT_REJECTED: " + "；".join(errors[:8])
        applied = 0
        pool = deepcopy(ctx.artifacts.get("pool") or {"chapter": "", "questions": []})
        qs = pool.get("questions", [])
        if type(args.get("verified_count")) is not int or args["verified_count"] != len(qs):
            return f"SUBMIT_REJECTED: verified_count 必须等于当前题库的真实题数 {len(qs)}，请逐题重解后如实提交。"
        issues = deepcopy(args.get("issues", []))
        for it in issues:
            it.pop("applied", None)
            it.pop("resolution_status", None)
            cq = it.get("corrected_question")
            if isinstance(cq, dict) and cq.get("id"):
                sub: List[str] = []
                schemas.validate_question(cq, 0, sub, set())
                if sub:
                    return (f"SUBMIT_REJECTED: corrected_question {cq.get('id')} 校验失败："
                            + "；".join(sub[:5]))
                for i, q in enumerate(qs):
                    if str(q.get("id")) == str(cq.get("id")):
                        if str(it.get("question_id")) != str(cq.get("id")):
                            return "SUBMIT_REJECTED: 修正题号必须与 issue.question_id 一致。"
                        if q.get("stage_index") is not None and cq.get("stage_index") is None:
                            cq["stage_index"] = q["stage_index"]
                        valid = {s.get("stage") for s in (ctx.artifacts.get("plan") or {}).get("learning_sequence", [])}
                        if valid and cq.get("stage_index") not in valid:
                            return "SUBMIT_REJECTED: 修正题目缺少有效的所属阶段。"
                        objectives = (ctx.artifacts.get("plan") or {}).get("learning_objectives", [])
                        if objectives and cq.get("learning_objective") not in objectives:
                            return "SUBMIT_REJECTED: 修正题目 learning_objective 必须逐字复制学习目标。"
                        if cq != q:
                            qs[i] = cq
                            applied += 1
                            it.update(applied=True, resolution_status="corrected")
                        else:
                            it["fix_applied"] = "无需修正，提交内容与现有题目一致。"
                        break
                else:
                    return "SUBMIT_REJECTED: corrected_question 题号不存在，验证修正不能新增题目。"
        pool["questions"] = qs
        ctx.artifacts["pool"] = pool
        if applied:
            atomic_write_json(ctx.workspace_dir / "question_pool.json", pool)
        verify = {"re_solved": args.get("re_solved"), "verified_count": args.get("verified_count"),
                  "issues": issues, "overall_pass": args.get("overall_pass"),
                  "coverage_notes": args.get("coverage_notes", ""), "notes": args.get("notes", ""),
                  "round": self._verify_round + 1, "corrections_applied": applied}
        verify = summarize_verification(verify, pool)
        ctx.artifacts["verify"] = verify
        ctx.artifacts["_verify_corrections"] = applied
        ctx.flags["verification_complete"] = True
        atomic_write_json(ctx.workspace_dir / "verification.json", verify)
        counts = verify["issue_counts"]
        ctx.emit(f"验证报告：重解 {verify.get('verified_count', '?')} 题，"
                 f"发现 {counts['found']} 项，修正 {counts['corrected']} 处，"
                 f"未解决 {counts['unresolved']} 项，无需修正 {counts['no_change_needed']} 项",
                 level="success" if verify["overall_pass"] else "warning")
        self._set_accepted("verify", "submit_verification", args)
        return (f"SUBMIT_ACCEPTED: 验证报告已记录（修正 {applied} 处）。"
                + ("系统将安排复查轮。" if applied and self._verify_round + 1 < config.MAX_VERIFY_ROUNDS else ""))

    # ================================================================ 工具日志钩子
    def _on_tool(self, name: str, args: Dict[str, Any], result_text: str) -> None:
        ctx = self.ctx
        if name == "read_pages" and result_text.startswith("{"):
            try:
                r = json.loads(result_text)
                if ctx.located and r.get("file") == ctx.located.get("file"):
                    cov = ctx.coverage_of(ctx.located["file"], ctx.located["start_page"],
                                          ctx.located["end_page"])
                    ctx.emit(f"阅读进度：已完整阅读 {cov['read']}/{cov['total']} 页", level="info")
            except json.JSONDecodeError:
                pass
        elif name == "search_local":
            ctx.emit(f"发现需要前置知识，正在检索：「{args.get('query', '')}」", level="info")
        elif name == "find_section":
            ctx.emit(f"正在教材中定位「{args.get('target', '')}」……", level="info")

    # ================================================================ 恢复
    def _restore_from(self, saved: Dict[str, Any]) -> None:
        ctx = self.ctx
        ctx.phase = saved.get("status", "TARGET")
        ctx.flags.update(saved.get("flags") or {})
        ctx.located = saved.get("located")
        coverage = saved.get("coverage")
        if isinstance(coverage, dict):
            ctx.coverage = {name: intervals for name, intervals in coverage.items()
                if isinstance(intervals, list) and all(
                    isinstance(iv, list) and len(iv) == 2 and all(type(n) is int for n in iv)
                    and 1 <= iv[0] <= iv[1] for iv in intervals)}
        fragments = saved.get("read_fragments")
        if isinstance(fragments, dict):
            for file, pages in fragments.items():
                if not isinstance(pages, dict):
                    continue
                for page, item in pages.items():
                    if (not isinstance(item, dict) or type(item.get("length")) is not int
                            or item["length"] < 1 or not isinstance(item.get("ranges"), list)):
                        continue
                    intervals = item["ranges"]
                    if all(isinstance(iv, list) and len(iv) == 2
                           and all(type(n) is int for n in iv) and 0 <= iv[0] < iv[1] <= item["length"]
                           for iv in intervals):
                        ctx.read_fragments.setdefault(file, {})[page] = item
        if saved.get("quality"):
            ctx.artifacts["quality"] = saved["quality"]
        if saved.get("allowed_files"):
            ctx.allowed_files = list(saved["allowed_files"])
        if saved.get("source_versions"):
            ctx.source_versions = saved["source_versions"]
        ctx.error = None
        # 恢复已有产物
        for key, fname in (("context", "chapter_context.json"), ("plan", "learning_plan.json"),
                           ("pool", "question_pool.json"), ("qa", "qa_report.json"),
                           ("verify", "verification.json")):
            f = ctx.workspace_dir / fname
            if f.exists():
                try:
                    artifact = json.loads(f.read_text(encoding="utf-8"))
                    if isinstance(artifact, dict):
                        ctx.artifacts[key] = artifact
                except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                    pass
        # 恢复对话历史
        ctx.load_messages()
        from .context import read_event_tail
        ctx.events = read_event_tail(ctx.workspace_dir / "events.jsonl")
        ctx.event_seq = max((event["seq"] for event in ctx.events), default=0)
        if ctx.phase not in ("TARGET", "LOCATE", "READ"):
            from ..store.quality import audit_source
            quality = audit_source(saved, ctx.artifacts.get("context"), ctx.artifacts.get("verify"))
            if quality.get("requiresReanalysis"):
                raise PhaseError("旧任务仅有目录依据，不能从生成阶段续跑；请重新定位并读取正文。")
            if not saved.get("quality"):
                quality = self._readable_coverage(ctx.located or {})
                if quality.get("readableCoverage", 0) < 0.6:
                    raise PhaseError("恢复任务缺少可读正文证据，请重新定位并完整读取正文。")
                quality.update(sourceAuditVersion=1, contentStatus="CONTENT_READY",
                               sourceScope="FULL_BODY" if quality["readableCoverage"] == 1 else "PARTIAL_BODY",
                               bodyContentCoverage=quality["readableCoverage"], locationState="BODY_READ")
            ctx.artifacts["quality"] = quality
