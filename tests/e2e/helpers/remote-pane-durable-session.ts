/**
 * Durable (main-process) view of an SSH host's terminal panes, plus the
 * snapshot write the app itself performs when a pane goes away.
 *
 * Why durable and not the renderer store: a reconnect binds PTYs in main. A
 * pane grafted there is invisible to the running renderer and only surfaces on
 * the next hydration — so the renderer census cannot see the defect at all.
 */
import type { Page } from '@stablyai/playwright-test'

/** `partition tabId/leafId=ptyId` for every pane a durable session names, sorted. */
export type DurablePaneBindings = string[]

/** Why both partitions: the renderer persists a remote worktree's panes to the
 *  host partition, while the reconnect binding path writes the local one. A
 *  census of either alone cannot see a pane grafted into the other. */
const LOCAL_PARTITION = 'local'

type DurableSession = {
  tabsByWorktree?: Record<string, { id: string }[]>
  terminalLayoutsByTabId?: Record<
    string,
    {
      root: unknown
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
  terminalPtyIncarnationsByPaneKey?: Record<string, string>
}

export function sshExecutionHostId(targetId: string): string {
  return `ssh:${encodeURIComponent(targetId)}`
}

export async function readDurablePaneBindings(
  page: Page,
  hostId: string,
  worktreeId: string
): Promise<DurablePaneBindings> {
  return page.evaluate(
    async ({ hostId, worktreeId, localPartition }) => {
      const readPartition = async (partition: string): Promise<string[]> => {
        const session = (await window.api.session.get(
          partition === localPartition ? undefined : partition
        )) as DurableSession | null
        const tabs = session?.tabsByWorktree?.[worktreeId] ?? []
        return tabs.flatMap((tab) =>
          Object.entries(session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}).map(
            ([leafId, ptyId]) => `${partition} ${tab.id}/${leafId}=${ptyId}`
          )
        )
      }
      return [...(await readPartition(localPartition)), ...(await readPartition(hostId))].sort()
    },
    { hostId, worktreeId, localPartition: LOCAL_PARTITION }
  )
}

/**
 * Persist the post-close layout the way quit/beforeunload does — a full replace
 * of the host partition that no longer names the closed pane. The remote shell
 * and its lease are deliberately left alone: that divergence (a live lease with
 * no durable pane) is the state a reconnect must not resolve by inventing UI.
 */
export async function persistClosedRemotePaneSnapshot(
  page: Page,
  args: { hostId: string; tabId: string; keptLeafId: string; closedLeafId: string }
): Promise<void> {
  await page.evaluate(async ({ hostId, tabId, keptLeafId, closedLeafId }) => {
    const session = (await window.api.session.get(hostId)) as DurableSession | null
    const layout = session?.terminalLayoutsByTabId?.[tabId]
    if (!session || !layout) {
      throw new Error(`No durable layout for tab ${tabId} on ${hostId}`)
    }
    const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
    delete ptyIdsByLeafId[closedLeafId]
    const incarnations = { ...session.terminalPtyIncarnationsByPaneKey }
    delete incarnations[`${tabId}:${closedLeafId}`]
    await window.api.session.set(
      {
        ...session,
        terminalLayoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [tabId]: {
            ...layout,
            root: { type: 'leaf', leafId: keptLeafId },
            activeLeafId: keptLeafId,
            expandedLeafId: null,
            ptyIdsByLeafId
          }
        },
        terminalPtyIncarnationsByPaneKey: incarnations
      } as never,
      hostId
    )
  }, args)
}
