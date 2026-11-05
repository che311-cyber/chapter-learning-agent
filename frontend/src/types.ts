// 与后端 API 契约对应的类型定义
export interface Health {
  ok: boolean
  model: string
  base_url: string
  key_configured: boolean
}

export interface ProjectInfo {
  name: string
  file_count: number
  last_activity?: number
}

export interface SourceFile {
  name: string
  size: number
  ext: string
  pages?: number
  parse_ok: boolean
  parse_error?: string
  mtime: number
}

export interface RunSummary {
  slug: string
  target?: string
  status: string
  updated_at?: number
  error?: string
}

export interface AgentEvent {
  seq: number
  ts: number
  phase: string
  level: 'info' | 'tool' | 'success' | 'warning' | 'error'
  message: string
}

export interface Located {
  file: string
  heading: string
  start_page: number
  end_page: number
  confidence?: string
  notes?: string
}

export interface StatusPayload {
  run_id: string
  project: string
  target?: string
  phase: string
  running: boolean
  flags: Record<string, boolean>
  error?: string
  located?: Located
  events_total: number
  events: AgentEvent[]
}

export interface DefinitionItem {
  term: string
  content: string
  source_file?: string
  source_page?: number
  sourceType?: 'textbook' | 'model_supplement' | 'teacher_added'
  sourceExcerpt?: string
}

export interface ChapterContext {
  chapter: string
  source_files: string[]
  core_concepts: string[]
  definitions: DefinitionItem[]
  theorems: { name: string; content: string; source_file?: string; source_page?: number }[]
  key_examples?: { name: string; content?: string }[]
  skills?: string[]
  common_mistakes?: string[]
  difficulty_points?: string[]
  prerequisites?: string[]
  source_references: { file: string; page?: number; locator?: string }[]
}

export interface PlanStage {
  stage: number
  name: string
  goal: string
  content: string[]
  practice?: string[]
  psychology_note?: string
}

export interface LearningPlan {
  chapter: string
  learning_objectives: string[]
  learning_sequence: PlanStage[]
  mastery_criteria: string[]
  common_failure_points?: (string | { failure: string; remedy?: string })[]
}

export interface Question {
  id: string
  stage_index?: number | string
  source_stage_index?: number
  question_category?: 'stage_question' | 'consolidation_question' | 'unassigned_question'
  placement_reason?: string
  type: string
  difficulty: 1 | 2 | 3
  learning_objective: string
  prompt: string
  options?: string[]
  answer: string
  explanation: string
  source_basis: string[]
}

export interface QuestionPool {
  chapter: string
  questions: Question[]
}

export interface QAItem {
  pass: boolean
  issues: string[]
  changes: string[]
  partial?: boolean
  justification?: string
}

export interface QAReport {
  clear_goal: QAItem
  immediate_feedback: QAItem
  real_progress: QAItem
  meaningful_agency: QAItem
  small_wins: QAItem
  challenge_skill_match: QAItem
  curiosity: QAItem
}

export interface VerificationReport {
  re_solved: boolean
  verified_count?: number
  issues: { question_id: string; severity?: string; problem: string; fix_applied?: string;
    resolution_status?: 'corrected' | 'unresolved' | 'no_change_needed'; applied?: boolean }[]
  corrections_applied?: number
  issue_counts?: { found: number; corrected: number; unresolved: number; no_change_needed: number }
  overall_pass: boolean
  coverage_notes?: string
  notes?: string
}

export interface ResultPayload {
  run_id: string
  status: string
  target?: string
  located?: Located
  review?: ReviewInfo
  tasks?: { task: string; at: number }[]
  learning_reports?: LearningReportSummary[]
  quality?: QualityInfo
  question_counts?: { current: number; published: number; visible_to_student: number }
  chapter_context: ChapterContext | null
  learning_plan: LearningPlan | null
  question_pool: QuestionPool | null
  qa_report: QAReport | null
  verification: VerificationReport | null
  markdown: Record<string, string>
  files: { workspace: string[]; output: string[] }
}

export interface ReviewInfo {
  status: 'draft' | 'needs_review' | 'approved' | 'published' | 'blocked'
  note?: string
  difficulty_note?: string
  updated_at?: number | null
  tasks?: { task: string; at: number }[]
  block_reasons?: string[]
  history?: { status: string; at: number; note?: string }[]
  teacher_override?: { at: number; reasons: string[] }
}

export interface QualityInfo {
  readableCoverage?: number
  bodyContentCoverage?: number | null
  rangeReadCoverage?: number
  pagesTotal?: number
  pagesReadable?: number
  ocrConfidence?: number | null
  locationConfidence?: 'high' | 'medium' | 'low'
  locationState?: string
  sourceScope?: string
  contentStatus?: string
  requiresReview?: boolean
  requiresReanalysis?: boolean
  tocPages?: number
  bodyPages?: number
}

export interface LearningReportSummary {
  submitted_at: number
  answered: number
  correct: number
  wrong: number
  accuracy: number | null
  game_xp?: number
  game_level?: number
  weak_objectives?: { objective: string; wrong: number; total: number }[]
  wrong_questions?: { id: string; prompt: string; answer: string }[]
  mastery?: { criterion: string; checked: boolean }[]
}

export const PHASES = [
  'TARGET',
  'LOCATE',
  'READ',
  'UNDERSTAND',
  'DESIGN',
  'GENERATE',
  'PSYCHOLOGY_CHECK',
  'VERIFY',
  'SAVE',
  'COMPLETE',
] as const

export const PHASE_LABELS: Record<string, string> = {
  TARGET: '解析目标',
  LOCATE: '定位章节',
  READ: '完整阅读章节',
  UNDERSTAND: '生成章节理解',
  DESIGN: '设计学习方案',
  GENERATE: '生成练习',
  PSYCHOLOGY_CHECK: '7条心理学原则检查',
  VERIFY: '独立验证',
  SAVE: '保存结果',
  COMPLETE: '完成',
}
