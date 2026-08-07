import type {
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../../shared/types'
import type { AiVaultSessionTitle } from '../../../../shared/ai-vault-session-title'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { clearTransientTerminalState } from './terminal-helpers'

/**
 * A persisted session describes the same terminals twice: as canonical unified tabs and as
 * legacy per-worktree terminal rows. Hydration keeps every row that still owns a PTY nothing
 * else can reattach to, drops rows the canonical mount fully subsumes, and strips the shared
 * PTYs off rows it only partially subsumes.
 */

type CanonicalTerminals = {
  /** Terminal ids the unified tab model owns in this workspace. */
  tabIds: Set<string>
  /** PTYs already claimed by canonical rows that survive hydration, keyed to their claimant. */
  tabIdByPtyId: Map<string, string>
  quickCommandLabelByTabId: Map<string, string>
  aiVaultTitleByTabId: Map<string, AiVaultSessionTitle>
}

export type HydrateWorkspaceTerminalRowsOptions = {
  /**
   * Rows arrived from a remote snapshot. `unifiedTabs` is not on the remote wire, so the session's
   * canonical list still describes the local client and cannot arbitrate ownership of these rows.
   */
  rowsFromRemoteSnapshot?: boolean
}

export type WorkspaceTerminalRowHydration = {
  rows: TerminalTab[]
  /** PTYs a retained row must give up because a canonical row already owns them. */
  releasedPtyIdsByTabId: Map<string, Set<string>>
  /** Rows dropped as pure canonical duplicates; they are never retired, so callers clean up after them. */
  subsumedTabIds: string[]
  /** The canonical row that inherited each subsumed row's PTYs, so pointers at it can follow. */
  canonicalTabIdBySubsumedTabId: Map<string, string>
}

export function hydrateWorkspaceTerminalRows(
  session: WorkspaceSessionState,
  worktreeId: string,
  rows: readonly TerminalTab[],
  options: HydrateWorkspaceTerminalRowsOptions = {}
): WorkspaceTerminalRowHydration {
  const canonical = readCanonicalTerminals(session, worktreeId, rows)
  const releasedPtyIdsByTabId = new Map<string, Set<string>>()
  const subsumedTabIds: string[] = []
  const canonicalTabIdBySubsumedTabId = new Map<string, string>()
  const retained: TerminalTab[] = []
  for (const row of rows) {
    // Why: old web-client mirrors could persist host surface ids with "::"; makePaneKey reserves ":" as its separator.
    if (!isValidTerminalTabId(row.id)) {
      continue
    }
    const claim = options.rowsFromRemoteSnapshot
      ? RETAINED_UNCLAIMED
      : resolveCanonicalPtyClaim(session, row, canonical)
    if (claim.kind === 'subsumed') {
      subsumedTabIds.push(row.id)
      canonicalTabIdBySubsumedTabId.set(row.id, claim.canonicalTabId)
      continue
    }
    if (claim.releasedPtyIds.size > 0) {
      releasedPtyIdsByTabId.set(row.id, claim.releasedPtyIds)
    }
    retained.push(row)
  }
  return {
    rows: retained
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
      .map((row, index) => restoreCanonicalMetadata(row, index, canonical)),
    releasedPtyIdsByTabId,
    subsumedTabIds,
    canonicalTabIdBySubsumedTabId
  }
}

/** Drop the PTYs a canonical row owns so the retained row records only its own panes. */
export function releaseTerminalLayoutPtyIds(
  layout: TerminalLayoutSnapshot,
  releasedPtyIds: ReadonlySet<string>
): TerminalLayoutSnapshot {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId
  if (!ptyIdsByLeafId) {
    return layout
  }
  const kept = Object.entries(ptyIdsByLeafId).filter(([, ptyId]) => !releasedPtyIds.has(ptyId))
  if (kept.length === Object.keys(ptyIdsByLeafId).length) {
    return layout
  }
  return { ...layout, ptyIdsByLeafId: Object.fromEntries(kept) }
}

function readCanonicalTerminals(
  session: WorkspaceSessionState,
  worktreeId: string,
  rows: readonly TerminalTab[]
): CanonicalTerminals {
  const canonicalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  const tabIds = new Set(canonicalTabs.map((tab) => tab.entityId))
  // Why: only rows that survive the id check can claim PTY ownership; a dropped invalid-id mirror must not evict the valid row sharing its PTY.
  const tabIdByPtyId = new Map(
    rows
      .filter((row) => tabIds.has(row.id) && isValidTerminalTabId(row.id))
      .flatMap((row) =>
        readPersistedTerminalPtyIds(session, row).owned.map((ptyId) => [ptyId, row.id] as const)
      )
  )
  return {
    tabIds,
    tabIdByPtyId,
    quickCommandLabelByTabId: new Map(
      canonicalTabs.flatMap((tab) =>
        tab.quickCommandLabel?.trim() ? [[tab.entityId, tab.quickCommandLabel.trim()]] : []
      )
    ),
    aiVaultTitleByTabId: new Map(
      canonicalTabs.flatMap((tab) => (tab.aiVaultTitle ? [[tab.entityId, tab.aiVaultTitle]] : []))
    )
  }
}

type CanonicalPtyClaim =
  | { kind: 'subsumed'; canonicalTabId: string }
  | { kind: 'retained'; releasedPtyIds: Set<string> }

const RETAINED_UNCLAIMED: CanonicalPtyClaim = { kind: 'retained', releasedPtyIds: new Set() }

/** Canonical mounts win PTY ownership over stale legacy duplicates of the same terminal. */
function resolveCanonicalPtyClaim(
  session: WorkspaceSessionState,
  row: TerminalTab,
  canonical: CanonicalTerminals
): CanonicalPtyClaim {
  if (canonical.tabIds.has(row.id)) {
    return RETAINED_UNCLAIMED
  }
  const { owned, orphaned } = readPersistedTerminalPtyIds(session, row)
  const claimed = owned.filter((ptyId) => canonical.tabIdByPtyId.has(ptyId))
  // Why: an unclaimed row has no canonical twin, which also keeps a PTY-less row — it duplicates
  // nothing — out of the fully-claimed branch.
  const canonicalTabId = claimed.length > 0 ? canonical.tabIdByPtyId.get(claimed[0]) : undefined
  if (canonicalTabId && claimed.length === owned.length) {
    return { kind: 'subsumed', canonicalTabId }
  }
  // Why: a split row with an independent pane owns a PTY nothing else can reattach to, but keeping the
  // shared PTY too would leave two recorded owners and make ownership resolution ambiguous (#10486).
  // Stale unmounted bindings go too, else reconnect republishes the canonical PTY under this row.
  return {
    kind: 'retained',
    releasedPtyIds: new Set([
      ...claimed,
      ...orphaned.filter((ptyId) => canonical.tabIdByPtyId.has(ptyId))
    ])
  }
}

function restoreCanonicalMetadata(
  row: TerminalTab,
  index: number,
  canonical: CanonicalTerminals
): TerminalTab {
  const quickCommandLabel =
    row.quickCommandLabel?.trim() || canonical.quickCommandLabelByTabId.get(row.id)
  const aiVaultTitle = row.aiVaultTitle ?? canonical.aiVaultTitleByTabId.get(row.id)
  return {
    ...clearTransientTerminalState(row, index),
    ...(quickCommandLabel ? { quickCommandLabel } : {}),
    ...(aiVaultTitle ? { aiVaultTitle } : {}),
    sortOrder: index,
    // Why: suppress restored mounts so only real activity updates Recent.
    pendingActivationSpawn: true
  }
}

type PersistedTerminalPtyIds = {
  /** PTYs a live pane or the tab itself still reattaches to — the only ones that prove ownership. */
  owned: string[]
  /** PTYs stranded in `ptyIdsByLeafId` by panes that already left the tree; they reattach nothing. */
  orphaned: string[]
}

function readPersistedTerminalPtyIds(
  session: WorkspaceSessionState,
  tab: TerminalTab
): PersistedTerminalPtyIds {
  const layout = session.terminalLayoutsByTabId[tab.id]
  // Why: ptyIdsByLeafId is merged but never pruned, and hydration reads it before
  // normalizeTerminalLayoutSnapshot runs, so unmounted leaves still carry dead bindings here.
  // Rootless layouts bind their sole pane off-tree, so treat every entry as mounted.
  const mountedLeafIds = layout?.root ? new Set(collectLeafIdsInOrder(layout.root)) : null
  const mounted: string[] = []
  const unmounted: string[] = []
  for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
    if (!ptyId) {
      continue
    }
    ;(!mountedLeafIds || mountedLeafIds.has(leafId) ? mounted : unmounted).push(ptyId)
  }
  const owned = new Set(
    [tab.ptyId, session.remoteSessionIdsByTabId?.[tab.id], ...mounted].filter(
      (ptyId): ptyId is string => Boolean(ptyId)
    )
  )
  return {
    owned: [...owned],
    orphaned: [...new Set(unmounted)].filter((ptyId) => !owned.has(ptyId))
  }
}
