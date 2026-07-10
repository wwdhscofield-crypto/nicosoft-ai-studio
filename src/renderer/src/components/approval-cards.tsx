// ApprovalCards — coordinator unattended-approval cards in the chat thread (doc 19 §8). A yellow card is
// an auto-approved note (the coordinator allowed an in-cwd write / network read — surfaced, not blocking);
// a red card is a hard-denied red-zone action recorded as pending — the user approves it (→ replayed in
// its cwd) or rejects it. Resolved red cards show their outcome instead of buttons.

import type { ReactElement } from 'react'
import type { ApprovalCard } from '@/stores/chat'
import { expertName, useAllExperts } from '@/lib/all-experts'

function statusLabel(c: ApprovalCard): string {
  if (c.status === 'executing') return 'Running…'
  if (c.status === 'approved') return `✓ Ran${c.result ? ` — ${c.result.slice(0, 140)}` : ''}`
  if (c.status === 'failed') return `✗ Failed${c.result ? ` — ${c.result.slice(0, 140)}` : ''}`
  if (c.status === 'rejected') return 'Rejected'
  return ''
}

export function ApprovalCards({
  cards,
  onApprove,
  onReject,
}: {
  cards: ApprovalCard[]
  onApprove: (pendingId: string) => void
  onReject: (pendingId: string) => void
}): ReactElement | null {
  const { byId } = useAllExperts() // custom agents raise approvals too — resolve their names, not raw ulids
  if (!cards.length) return null
  return (
    <div className="ac-list">
      {cards.map((c) => {
        const name = expertName(byId, c.roleId)
        if (c.zone === 'yellow') {
          return (
            <div key={c.key} className="ac-card ac-yellow">
              <span className="ac-tag">auto-approved</span>
              <span className="ac-body">
                {name} ran <code>{c.toolName}</code> — {c.reason}
              </span>
            </div>
          )
        }
        return (
          <div key={c.key} className="ac-card ac-red">
            <div className="ac-row">
              <span className="ac-tag ac-tag-red">needs approval</span>
              <span className="ac-body">
                {name} wants to run <code>{c.toolName}</code> — {c.reason}
              </span>
            </div>
            {c.status === 'open' && c.pendingId ? (
              <div className="ac-actions">
                <button className="ac-reject" onClick={() => onReject(c.pendingId!)}>
                  Reject
                </button>
                <button className="ac-approve" onClick={() => onApprove(c.pendingId!)}>
                  Approve &amp; run
                </button>
              </div>
            ) : (
              <div className="ac-status">{statusLabel(c)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
