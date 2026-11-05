import { useMemo } from 'react'

/** 轻量 Markdown 渲染（标题/列表/粗体/行内代码/分隔线），不引入第三方依赖。 */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => render(text || ''), [text])
  return <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/<details>/g, '&lt;details&gt;')
}

function render(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  let inDetails = false

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()

    if (/^<\/details>/.test(t)) {
      if (inDetails) { out.push('</div>'); inDetails = false }
      continue
    }
    if (/^<details>/.test(t)) {
      closeList()
      out.push('<div style="margin-top:8px">')
      inDetails = true
      continue
    }
    if (/^(---|___)$/.test(t)) { closeList(); out.push('<hr/>'); continue }
    if (/^###\s+/.test(t)) { closeList(); out.push(`<h3>${inline(t.slice(4))}</h3>`); continue }
    if (/^##\s+/.test(t)) { closeList(); out.push(`<h2>${inline(t.slice(3))}</h2>`); continue }
    if (/^#\s+/.test(t)) { closeList(); out.push(`<h1>${inline(t.slice(2))}</h1>`); continue }
    if (/^[-*]\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(t.slice(2))}</li>`)
      continue
    }
    if (/^>\s?/.test(t)) {
      closeList()
      out.push(`<blockquote style="border-left:3px solid var(--border);margin:8px 0;padding:4px 12px;color:var(--text-dim)">${inline(t.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^\d+\.\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(t.replace(/^\d+\.\s+/, ''))}</li>`)
      continue
    }
    if (t.startsWith('**答案**') || t.startsWith('**解析**') || t.startsWith('**教材依据**')) {
      out.push(`<div>${inline(t)}</div>`)
      continue
    }
    if (t === '') { closeList(); continue }
    closeList()
    out.push(`<p style="margin:6px 0">${inline(t)}</p>`)
  }
  closeList()
  if (inDetails) out.push('</div>')
  return out.join('\n')
}
