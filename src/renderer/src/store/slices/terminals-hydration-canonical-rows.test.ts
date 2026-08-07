import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: apiProxy() }

describe('hydrateWorkspaceSession canonical terminal rows', () => {
  it('restores only canonical terminal rows from unified sessions', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const sharedPtyId = 'daemon-session-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })

    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'stale-tab',
      activeWorktreeIdsOnShutdown: [worktreeId],
      activeTabIdByWorktree: { [worktreeId]: 'stale-tab' },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'canonical-tab', worktreeId, ptyId: sharedPtyId }),
          makeTab({ id: 'stale-tab', worktreeId, ptyId: sharedPtyId })
        ]
      },
      terminalLayoutsByTabId: {
        'canonical-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId }
        },
        'stale-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'stale-leaf': sharedPtyId }
        }
      },
      remoteSessionIdsByTabId: {
        'canonical-tab': sharedPtyId,
        'stale-tab': sharedPtyId
      },
      unifiedTabs: {
        [worktreeId]: [
          {
            id: 'canonical-unified-tab',
            entityId: 'canonical-tab',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Grok',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [worktreeId]: [
          {
            id: 'group-1',
            worktreeId,
            activeTabId: 'canonical-unified-tab',
            tabOrder: ['canonical-unified-tab']
          }
        ]
      }
    }

    store.getState().hydrateWorkspaceSession(session)
    store.getState().hydrateTabsSession(session)
    const reconciliation = store.getState().reconcileWorktreeTabModel(worktreeId)
    const state = store.getState()

    expect(reconciliation.renderableTabCount).toBe(1)
    expect(state.unifiedTabsByWorktree[worktreeId]?.map((tab) => tab.entityId)).toEqual([
      'canonical-tab'
    ])
    expect(state.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual(['canonical-tab'])
    expect(state.terminalLayoutsByTabId['stale-tab']).toBeUndefined()
    expect(state.pendingReconnectTabByWorktree[worktreeId]).toEqual(['canonical-tab'])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'canonical-tab': sharedPtyId
    })
    expect(state.activeTabId).toBeNull()
    expect(state.activeTabIdByWorktree).toEqual({})
  })
})
