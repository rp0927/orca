import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
const RECONNECT_CYCLES = 3
// Why: the relay must outlive every disconnect. If it exits with the client the
// remote shells die too, reconnect degrades to a cold spawn, and the reattach
// path this spec exists to bound is never entered.
const RELAY_GRACE_PERIOD_SECONDS = 900

test.use({ seedTestRepo: false })

/** Every terminal pane the user can see in a workspace, keyed tab/leaf. */
type RemotePaneCensus = {
  tabIds: string[]
  paneIds: string[]
}

async function readRemotePaneCensus(page: Page, worktreeId: string): Promise<RemotePaneCensus> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    type LayoutNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: LayoutNode; second: LayoutNode }
      | null
    const collectLeafIds = (node: LayoutNode): string[] => {
      if (!node) {
        return []
      }
      return node.type === 'leaf'
        ? [node.leafId]
        : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
    }
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const paneIds = tabs.flatMap((tab) => {
      const leafIds = collectLeafIds(
        (state.terminalLayoutsByTabId[tab.id]?.root ?? null) as LayoutNode
      )
      // Why: `root: null` is the implicit single-pane layout a fresh tab carries
      // until it is first split, so it still counts as one visible pane.
      return leafIds.length > 0
        ? leafIds.map((leafId) => `${tab.id}/${leafId}`)
        : [`${tab.id}/<root>`]
    })
    return { tabIds: tabs.map((tab) => tab.id), paneIds: paneIds.sort() }
  }, worktreeId)
}

// STA-3077: reconnecting an SSH-backed workspace must be cardinality-neutral.
// The report had relay PTYs go 2 -> 19 -> 20 over three reconnects while panes
// the user never opened appeared alongside them, so both counts are asserted
// against the same fixed workspace after every cycle.
test.describe('SSH reconnect pane and remote PTY cardinality', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH reconnect uses POSIX SSH tooling.')

  test('adds no panes and no remote PTYs across repeated reconnects', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(480_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, relayTarget, {
        relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
      })
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      await splitActiveTerminalPane(orcaPage, 'vertical')
      await waitForPaneIdentitySnapshot(orcaPage, PANE_COUNT)
      const baselinePanes = await readRemotePaneCensus(orcaPage, remote.worktreeId)
      expect(baselinePanes.paneIds).toHaveLength(PANE_COUNT)

      // The remote census is the reporter's oracle: shells the relay hosts right
      // now, counted on the container rather than inferred from app state.
      await expect
        .poll(() => readDockerSshRelayRemotePtys(relayTarget).length, {
          timeout: 60_000,
          message: 'remote shells did not settle at one per pane before the first reconnect'
        })
        .toBe(PANE_COUNT)
      const baselineRemotePtys = readDockerSshRelayRemotePtys(relayTarget)
      const baselinePids = baselineRemotePtys.map((pty) => pty.pid)
      testInfo.annotations.push({
        type: 'ssh-reconnect-cardinality-baseline',
        description: describeDockerSshRelayRemotePtys(baselineRemotePtys)
      })

      for (let cycle = 1; cycle <= RECONNECT_CYCLES; cycle += 1) {
        await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
        await ensureTerminalVisible(orcaPage, 45_000)
        await waitForActiveTerminalManager(orcaPage, 60_000)
        await waitForActivePanePtyId(orcaPage, 60_000)

        // Poll rather than sample once: a leaked pane or a duplicate shell can
        // land after reattach reports ready, and a single read would miss it.
        await expect
          .poll(() => readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid), {
            timeout: 90_000,
            message: `reconnect ${cycle} changed the live remote shells`
          })
          .toEqual(baselinePids)
        await expect
          .poll(async () => (await readRemotePaneCensus(orcaPage, remote.worktreeId)).paneIds, {
            timeout: 30_000,
            message: `reconnect ${cycle} changed the visible terminal panes`
          })
          .toEqual(baselinePanes.paneIds)
        expect(
          (await readRemotePaneCensus(orcaPage, remote.worktreeId)).tabIds,
          `reconnect ${cycle} changed the workspace tabs`
        ).toEqual(baselinePanes.tabIds)

        // Settle before the next cycle so a late graft is attributed to the
        // reconnect that caused it instead of leaking into the next assertion.
        await expect
          .poll(() => readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid), {
            intervals: [2_000, 2_000, 2_000],
            timeout: 8_000,
            message: `reconnect ${cycle} grew the remote shells after settling`
          })
          .toEqual(baselinePids)
      }

      testInfo.annotations.push({
        type: 'ssh-reconnect-cardinality-final',
        description: `${RECONNECT_CYCLES} reconnects: ${describeDockerSshRelayRemotePtys(
          readDockerSshRelayRemotePtys(relayTarget)
        )}`
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
