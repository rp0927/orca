import { randomUUID } from 'node:crypto'
import { expect, test, type TestInfo } from '@playwright/test'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../../src/main/daemon/daemon-pty-router'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  cleanupDaemonGenerationFixtures,
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  spawnGenerationCanary,
  type DaemonGeneration,
  type DaemonGenerationRuntime,
  type GenerationCanary
} from './helpers/daemon-generation-safety-fixtures'
import { processIdentityLiveness, waitForCondition } from './helpers/daemon-generation-processes'

const LEGACY_PROTOCOL_VERSION = 23

type CanaryLiveness = { root: boolean; descendant: boolean }

async function canaryLiveness(canary: GenerationCanary): Promise<CanaryLiveness> {
  const live = await processIdentityLiveness([canary.rootIdentity, canary.descendantIdentity])
  return {
    root: live.get(canary.rootIdentity.pid) === true,
    descendant: live.get(canary.descendantIdentity.pid) === true
  }
}

/** Models the app process going away while the daemon keeps the PTY. */
async function quitAppSideOfCanary(canary: GenerationCanary): Promise<void> {
  await canary.adapter.disconnectOnly()
  canary.adapter.dispose()
}

/** Rebuilds exactly what a restarted app constructs: cold adapters, no route, no inventory. */
function restartedAppRouter(generations: readonly DaemonGeneration[]): {
  router: DaemonPtyRouter
  adapters: DaemonPtyAdapter[]
} {
  const adapters = generations.map(
    (generation) =>
      new DaemonPtyAdapter({
        socketPath: generation.socketPath,
        tokenPath: generation.tokenPath,
        protocolVersion: generation.protocolVersion
      })
  )
  const current = adapters[0]!
  return { router: new DaemonPtyRouter({ current, legacy: adapters.slice(1) }), adapters }
}

/** Proves the rebound id still reaches the *original* canary process, not a lookalike shell. */
async function pingCanaryThroughRouter(
  router: DaemonPtyRouter,
  canary: GenerationCanary
): Promise<void> {
  const label = `${canary.generation.label}-${canary.role}`
  const nonce = randomUUID()
  let observed = ''
  const unsubscribe = router.onData((event) => {
    if (event.id === canary.sessionId) {
      observed = `${observed}${event.data}`.slice(-32_768)
    }
  })
  try {
    router.write(canary.sessionId, `PING ${label} ${nonce}\r`)
    await waitForCondition(`${label} canary reply after rebind`, () =>
      observed.includes(`ORCA_GENERATION_CANARY_ACK ${label} ${nonce}`)
    )
  } finally {
    unsubscribe()
  }
}

/** Every session this daemon generation actually created or attached. */
function sessionOwnershipEvents(generation: DaemonGeneration, sessionId: string): string[] {
  return generation
    .logEvents()
    .filter(
      (event) =>
        event.sessionId === sessionId &&
        (event.event === 'session-created' || event.event === 'session-attached')
    )
    .map((event) => String(event.event))
}

async function inspectionVerdict(router: DaemonPtyRouter, sessionId: string): Promise<string> {
  try {
    await router.inspectProcess(sessionId)
    return 'resolved'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function cleanup(options: {
  runtime: DaemonGenerationRuntime
  generations: readonly DaemonGeneration[]
  canaries: readonly GenerationCanary[]
  adapters: readonly DaemonPtyAdapter[]
  retainDiagnostics: boolean
}): Promise<void> {
  for (const adapter of options.adapters) {
    adapter.dispose()
  }
  if (options.retainDiagnostics) {
    options.runtime.retainDiagnostics(options.generations)
  }
  try {
    await cleanupDaemonGenerationFixtures({
      generations: options.generations,
      canaries: options.canaries
    })
  } catch (error) {
    options.runtime.retainDiagnostics(options.generations)
    throw error
  }
  options.runtime.remove()
}

test.describe.configure({ mode: 'serial' })

test('a restarted client reads a daemon-held PTY as unknown, never dead, and rebinds the same shell', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(120_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  let adapters: DaemonPtyAdapter[] = []
  let assertionsComplete = false

  try {
    const daemon = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PROTOCOL_VERSION}`,
      protocolVersion: PROTOCOL_VERSION
    })
    generations.push(daemon)
    const canary = await spawnGenerationCanary({ runtime, generation: daemon, role: 'live' })
    canaries.push(canary)
    const sessionId = canary.sessionId

    await quitAppSideOfCanary(canary)
    // Ground truth for every assertion below: the shell and its child are still running.
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })

    const restarted = restartedAppRouter(generations)
    adapters = restarted.adapters
    const { router } = restarted

    // Why this is the whole journey: a restarted client has an empty session cache and a
    // socket it has not dialled yet. Absence of evidence is not evidence of absence — the
    // only honest answer here is "unknown". Answering false hands the renderer's
    // dead-session reconcile a licence to exit a pane whose shell is running.
    expect.soft(router.hasPty(sessionId)).toBeNull()
    expect.soft(await inspectionVerdict(router, sessionId)).not.toBe('terminal_gone')
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })

    // The production reattach: attach-only, never a create.
    const reattached = await router.spawn({
      sessionId,
      isNewSession: false,
      attachOnly: true,
      cols: 100,
      rows: 30,
      cwd: runtime.rootDir
    })
    expect(reattached).toMatchObject({ id: sessionId, isReattach: true })
    expect(router.hasPty(sessionId)).toBe(true)

    // Same PTY, not a lookalike: the original canary process answers on the new connection.
    await pingCanaryThroughRouter(router, canary)
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })
    assertionsComplete = true
  } finally {
    await cleanup({
      runtime,
      generations,
      canaries,
      adapters,
      retainDiagnostics: !assertionsComplete
    })
  }
})

test('a session held by a preserved daemon generation is never resolved against the successor', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(120_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  let adapters: DaemonPtyAdapter[] = []
  let assertionsComplete = false

  try {
    const successor = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PROTOCOL_VERSION}`,
      protocolVersion: PROTOCOL_VERSION
    })
    const preserved = await launchDaemonGeneration({
      runtime,
      label: `generation-v${LEGACY_PROTOCOL_VERSION}`,
      protocolVersion: LEGACY_PROTOCOL_VERSION
    })
    generations.push(successor, preserved)
    const canary = await spawnGenerationCanary({ runtime, generation: preserved, role: 'live' })
    canaries.push(canary)
    const sessionId = canary.sessionId

    await quitAppSideOfCanary(canary)
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })

    const restarted = restartedAppRouter(generations)
    adapters = restarted.adapters
    const { router } = restarted
    const successorAdapter = adapters[0]!

    // Skew fails closed in the safe direction first: the successor owns nothing here, and
    // its silence must not be read as the preserved generation's session being gone.
    expect.soft(router.hasPty(sessionId)).toBeNull()
    expect.soft(await inspectionVerdict(router, sessionId)).not.toBe('terminal_gone')

    // An operation aimed at the wrong generation is refused, not applied to the successor.
    await expect(successorAdapter.attach(sessionId)).rejects.toThrow()
    expect(sessionOwnershipEvents(successor, sessionId)).toEqual([])
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })

    // The owner is still reachable through the router, and it is the preserved generation.
    await router.discoverLegacySessions()
    const reattached = await router.spawn({
      sessionId,
      isNewSession: false,
      attachOnly: true,
      cols: 100,
      rows: 30,
      cwd: runtime.rootDir
    })
    expect(reattached).toMatchObject({ id: sessionId, isReattach: true })
    await pingCanaryThroughRouter(router, canary)
    expect(sessionOwnershipEvents(preserved, sessionId)).toContain('session-attached')
    expect(sessionOwnershipEvents(successor, sessionId)).toEqual([])
    expect(await canaryLiveness(canary)).toEqual({ root: true, descendant: true })
    assertionsComplete = true
  } finally {
    await cleanup({
      runtime,
      generations,
      canaries,
      adapters,
      retainDiagnostics: !assertionsComplete
    })
  }
})
