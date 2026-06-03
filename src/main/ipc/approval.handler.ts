// approval.handler.ts — deferred-approval IPC (doc 19 §8). The renderer lists a conversation's pending
// red-zone actions, then approves (→ the action is replayed in its cwd) or rejects them. The list/approve/
// reject + replay logic lives in approval.service; this is just the IPC surface.

import { ipcMain } from 'electron'
import * as approvalService from '../services/approval.service'
import type { PendingApprovalRow } from '../repos/pending-approval.repo'
import type { PendingApprovalDto } from './contracts'

function toDto(r: PendingApprovalRow): PendingApprovalDto {
  return { id: r.id, roleId: r.roleId, toolName: r.toolName, toolInput: r.toolInput, cwd: r.cwd, reason: r.reason, createdAt: r.createdAt }
}

export function registerApprovalHandlers(): void {
  ipcMain.handle('approval:list', (_e, convId: string): PendingApprovalDto[] => approvalService.listPending(convId).map(toDto))
  ipcMain.handle('approval:approve', (_e, id: string) => approvalService.approve(id))
  ipcMain.handle('approval:reject', (_e, id: string): boolean => approvalService.reject(id))
}
