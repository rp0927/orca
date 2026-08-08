/**
 * Pane and remote-PTY cardinality across reconnects, against a real OpenSSH
 * container.
 *
 * Two tests, with different standing:
 *
 * 1. 'adds no panes and no remote PTYs across repeated reconnects' is a forward
 *    guard only. It passes with and without the STA-3077 fixes: a cleanly
 *    severed transport reconnects without producing the divergence that grafted
 *    panes in the field. It still earns its place by counting the shells the
 *    relay hosts, on the container, and pinning their PIDs.
 *
 * 2. 'leaves a lease whose durable pane is gone unbound…' discriminates. It
 *    reproduces the divergence — a live lease and a live remote shell that no
 *    durable pane names — and fails on a tree without the fix, where reattach
 *    grafts the pane back through persistPtyBinding's creating branches.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  closeActiveTerminalPane,
  focusLastTerminalPane,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import {
  persistClosedRemotePaneSnapshot,
  readDurablePaneBindings,
  sshExecutionHostId
} from './helpers/remote-pane-durable-session'
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

type StreamingRemoteWorkspace = {
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  paneSnapshot: Awaited<ReturnType<typeof waitForPaneIdentitySnapshot>>
  baselinePanes: RemotePaneCensus
  baselineRemotePtys: ReturnType<typeof readDockerSshRelayRemotePtys>
}

/** A connected remote workspace with PANE_COUNT panes, each streaming output. */
async function openStreamingRemotePanes(
  page: Page,
  relayTarget: DockerSshRelayTarget
): Promise<StreamingRemoteWorkspace> {
  await waitForSessionReady(page)
  const remote = await connectDockerSshRelayTarget(page, relayTarget, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)

  await splitActiveTerminalPane(page, 'vertical')
  const paneSnapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)
  const baselinePanes = await readRemotePaneCensus(page, remote.worktreeId)
  expect(baselinePanes.paneIds).toHaveLength(PANE_COUNT)

  // Why every pane must be streaming: an idle pane carries no output source,
  // so its reattach sends no recovery checkpoint and the relay answers
  // 'existing'. Only a live source can come back needing re-establishment,
  // which is the outcome that used to read as expiry and respawn the shell.
  const streamMarker = `SSH_RECONNECT_STREAM_${Date.now()}`
  for (const pane of paneSnapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Pane ${pane.leafId} has no PTY to stream from`)
    }
    await sendToTerminal(
      page,
      pane.ptyId,
      `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),25)"\r`
    )
  }
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(relayTarget, streamMarker), {
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
  return {
    remote,
    paneSnapshot,
    baselinePanes,
    baselineRemotePtys: readDockerSshRelayRemotePtys(relayTarget)
  }
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
      const { remote, baselinePanes, baselineRemotePtys } = await openStreamingRemotePanes(
        orcaPage,
        relayTarget
      )
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

  // The divergence the field hit: a lease and its remote shell outlive the pane
  // record, because the pane was closed while the link was down and the kill
  // never reached the host. Reconnect must reattach without inventing the pane
  // back, and without killing the shell it can no longer place.
  test('leaves a lease whose durable pane is gone unbound instead of grafting the pane back', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(480_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const { remote, paneSnapshot, baselineRemotePtys } = await openStreamingRemotePanes(
        orcaPage,
        relayTarget
      )
      const baselinePids = baselineRemotePtys.map((pty) => pty.pid)
      const hostId = sshExecutionHostId(remote.targetId)
      const keptLeafId = paneSnapshot.panes[0]!.leafId
      const closedLeafId = paneSnapshot.panes[1]!.leafId
      const readBindings = (): Promise<string[]> =>
        readDurablePaneBindings(orcaPage, hostId, remote.worktreeId)
      expect(
        (await readBindings()).filter((binding) => binding.includes(closedLeafId)),
        'the pane to be closed must start out durably bound'
      ).not.toHaveLength(0)

      severDockerSshRelayTransport(relayTarget)
      // Closing here is what leaves the lease orphaned: pty:kill fails with the
      // transport down, so the remote shell and its lease both survive the pane.
      await focusLastTerminalPane(orcaPage)
      await closeActiveTerminalPane(orcaPage)
      await expect
        .poll(
          async () => (await readRemotePaneCensus(orcaPage, remote.worktreeId)).paneIds.length,
          {
            timeout: 30_000,
            message: 'the closed pane never left the visible layout'
          }
        )
        .toBe(PANE_COUNT - 1)
      await persistClosedRemotePaneSnapshot(orcaPage, {
        hostId,
        tabId: paneSnapshot.tabId,
        keptLeafId,
        closedLeafId
      })
      await expect
        .poll(async () => (await readBindings()).filter((b) => b.includes(closedLeafId)).length, {
          timeout: 30_000,
          message: 'a durable partition still named the closed pane before the reconnect'
        })
        .toBe(0)
      const survivingBindings = await readBindings()
      expect(
        survivingBindings.filter((binding) => binding.includes(keptLeafId)),
        'the surviving pane must stay durably bound'
      ).not.toHaveLength(0)

      await waitForSshReconnected(orcaPage, remote.targetId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // Sample continuously rather than poll-until-equal: a graft that lands and
      // is later overwritten by a renderer snapshot would satisfy a poll that
      // only needs one matching read, and the defect would pass unnoticed.
      const deadline = Date.now() + 25_000
      let samples = 0
      while (Date.now() < deadline) {
        expect(await readBindings(), 'reconnect grafted a pane the user had closed').toEqual(
          survivingBindings
        )
        samples += 1
        await orcaPage.waitForTimeout(500)
      }
      expect(samples).toBeGreaterThan(10)

      // Unknown is not dead: the orphaned shell keeps running, so a later
      // reattach can still claim it once a durable pane names it again.
      expect(
        readDockerSshRelayRemotePtys(relayTarget).map((pty) => pty.pid),
        'the orphaned remote shell was killed or respawned'
      ).toEqual(baselinePids)
      expect(
        (await readRemotePaneCensus(orcaPage, remote.worktreeId)).paneIds,
        'reconnect surfaced a pane the user never opened'
      ).toHaveLength(PANE_COUNT - 1)
      testInfo.annotations.push({
        type: 'ssh-reconnect-orphaned-lease-final',
        description: describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(relayTarget))
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
