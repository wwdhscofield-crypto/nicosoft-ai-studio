/* ============================================================
   Pagination — reusable page control (Prev · numbered pages w/ ellipsis · Next).
   0-indexed `page` in/out; renders 1-indexed labels. Hidden when there's a single page.
   ============================================================ */
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'

// Build the page-number sequence: all pages when few, else 1 … around-current … last.
function pageItems(page: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i)
  const out: (number | 'gap')[] = [0]
  const start = Math.max(1, page - 1)
  const end = Math.min(count - 2, page + 1)
  if (start > 1) out.push('gap')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < count - 2) out.push('gap')
  out.push(count - 1)
  return out
}

export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onChange
}: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onChange: (page: number) => void
}): ReactElement | null {
  if (pageCount <= 1) return null
  const go = (p: number): void => onChange(Math.min(pageCount - 1, Math.max(0, p)))
  const start = page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)
  return (
    <div className="pagination" role="navigation" aria-label="Pagination">
      <span className="pg-info">
        Showing {start}–{end} of {total} · page {page + 1} / {pageCount}
      </span>
      <div className="pg-controls">
        <button className="pg-btn" disabled={page === 0} onClick={() => go(page - 1)} aria-label="Previous page">
          <Icons.chevronLeft size={15} />
        </button>
        {pageItems(page, pageCount).map((it, i) =>
          it === 'gap' ? (
            <span key={`gap${i}`} className="pg-gap">…</span>
          ) : (
            <button
              key={it}
              className={'pg-num' + (it === page ? ' active' : '')}
              aria-current={it === page ? 'page' : undefined}
              onClick={() => go(it)}
            >
              {it + 1}
            </button>
          )
        )}
        <button className="pg-btn" disabled={page === pageCount - 1} onClick={() => go(page + 1)} aria-label="Next page">
          <Icons.chevronRight size={15} />
        </button>
      </div>
    </div>
  )
}
