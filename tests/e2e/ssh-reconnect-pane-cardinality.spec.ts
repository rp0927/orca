/**
 * Forward regression guard for pane and remote-PTY cardinality across
 * reconnects, run against a real OpenSSH container.
 *
 * Scope, stated honestly: this spec passes both with and without the STA-3077
 * fixes — it was run against an unfixed tree and did not fail. A clean severed
 * transport reconnects without producing the conditions that grafted panes in
 * the field, which needed accumulated duplicate leases or a source that came
 * back needing re-establishment. So it does NOT prove those fixes; the oracles
 * that do are in `src/main/ssh-reattach-pane-cardinality.test.ts`.
 *
 * It still earns its place: it counts the shells the relay actually hosts, on
 * the container, and pins their PIDs — so a future change that grafts a pane or
 * kills and respawns a shell fails here.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
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
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { severDockerSshRelayTransport } from './helpers/docker-ssh-relay-processes'
import {
  countDockerSshRelayRemoteStreamWriters,
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
const RECONNECT_CYCLES = 3
// Why: the relay must outlive every fault. If it exits with the client the
// remote shells die too, reconnect degrades to a cold spawn, and the reattach
// path this spec exists to bound is never entered.
const RELAY_GRACE_PERIOD_SECONDS = 900
// Why: a graft lands after reattach reports ready, so the census has to be
// re-read once the dust settles rather than the instant the wait passes.
const SETTLE_MS = 6_000

test.use({ seedTestRepo: false })

async function waitForSshReconnected(page: Page, targetId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (targetId) => (await window.api.ssh.getState({ targetId }))?.status ?? null,
          targetId
        ),
      {
        timeout: 120_000,
        message: 'SSH target did not reconnect after its transport was severed'
      }
    )
    .toBe('connected')
}

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
      const paneSnapshot = await waitForPaneIdentitySnapshot(orcaPage, PANE_COUNT)
      const baselinePanes = await readRemotePaneCensus(orcaPage, remote.worktreeId)
      expect(baselinePanes.paneIds).toHaveLength(PANE_COUNT)

      // Why every pane must be streaming: an idle pane carries no output source,
      // so its reattach sends no recovery checkpoint and the relay answers
      // 'existing'. Only a live source can come back needing re-establishment,
      // which is the outcome that used to read as expiry and respawn the shell.
      const streamMarker = `SSH_RECONNECT_STREAM_${Date.now()}`
      const countRemoteStreamWriters = (): number =>
        countDockerSshRelayRemoteStreamWriters(relayTarget, streamMarker)
      for (const pane of paneSnapshot.panes) {
        if (!pane.ptyId) {
          throw new Error(`Pane ${pane.leafId} has no PTY to stream from`)
        }
        await sendToTerminal(
          orcaPage,
          pane.ptyId,
          `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),25)"\r`
        )
      }
      await expect
        .poll(countRemoteStreamWriters, {
          timeout: 60_000,
          message: 'remote panes did not start streaming before the first transport fault'
        })
        .toBe(PANE_COUNT)

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
        severDockerSshRelayTransport(relayTarget)
        await waitForSshReconnected(orcaPage, remote.targetId)
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

        // Why not poll here: poll returns on its first passing probe, so
        // re-polling a value that already matched waits 0ms and observes
        // nothing. Sit out the settle window, then re-read every dimension a
        // late graft could move, so it is attributed to the reconnect that
        // caused it instead of leaking into the next cycle.
        await orcaPage.waitForTimeout(SETTLE_MS)
        const settled = await readRemotePaneCensus(orcaPage, remote.worktreeId)
        expect(
          readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid),
          `reconnect ${cycle} changed the remote shells after settling`
        ).toEqual(baselinePids)
        expect(
          settled.paneIds,
          `reconnect ${cycle} changed the visible terminal panes after settling`
        ).toEqual(baselinePanes.paneIds)
        expect(
          settled.tabIds,
          `reconnect ${cycle} changed the workspace tabs after settling`
        ).toEqual(baselinePanes.tabIds)
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
