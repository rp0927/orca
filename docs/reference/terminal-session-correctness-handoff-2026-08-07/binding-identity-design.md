# Design: one authoritative binding identity

Status: **proposal, not accepted.** Written 2026-08-08 by the engineer who took
the program over. Supersedes nothing until reviewed.

## The problem, stated once

Every defect this program has touched is the same defect: **identity compared
with the wrong key, or not compared at all.**

| Defect                 | Mechanism                                                               |
| ---------------------- | ----------------------------------------------------------------------- |
| STA-3077 RC1           | lease keyed `(targetId, ptyId)`; pane fields present but not in the key |
| STA-3077 RC3           | reattach used a _creating_ store write                                  |
| #12474 (live on main)  | `runtimeWorktreeIdsEqual` strips the folder-workspace instance suffix   |
| Local exact operations | `pty:write/resize/signal/kill` take `{ id }` — no binding to compare    |
| `restoreRequired`      | classified as expiry, so a live shell read as gone                      |
| `hasPty`               | `boolean` — an empty inventory could not say "unknown"                  |

The prior redesign failed because it built a _second_ identity system beside
the first instead of fixing the first. It reached +60,903 production LOC and
fixed none of RC1–RC3.

## The rule

**A mutating terminal operation must name the binding it intends to affect, and
the compiler must reject a bare id.**

Not a new subsystem. A type, one comparison, and a signature change.

## 1. `PtyBinding` — one branded type

```ts
declare const bindingBrand: unique symbol

export type PtyBinding = Readonly<{
  hostId: ExecutionHostId // exists — LOCAL_EXECUTION_HOST_ID | ssh:<target>
  worktreeId: WorktreeId // exists — `${repoId}::${path}[::workspace:<uuid>]`
  paneKey: PaneKey // exists — `${tabId}:${leafId}`, already branded
  ptyId: string // exists
  incarnationId: PtyIncarnationId // exists — already branded
}> & { readonly [bindingBrand]: true }
```

Every field already exists and is already persisted. Nothing is invented.

Construction is the whole point: `PtyBinding` is producible **only** by
`bindingFromAuthority()` — reading the durable store, a spawn result, or an
attach reply. There is no public constructor from loose strings, so a caller
cannot fabricate one, and `as PtyBinding` is banned by lint.

## 2. Mutating IPC carries the binding

Today, on the local path:

```ts
pty: write({ id, data })
pty: resize({ id, cols, rows })
pty: signal({ id, signal })
pty: kill({ id })
```

There is no fence to test because there is nothing to compare. That is a
production gap, not a test gap.

After:

```ts
pty: write({ binding, data })
pty: resize({ binding, cols, rows })
pty: signal({ binding, signal })
pty: kill({ binding })
```

The handler resolves the binding against the authoritative record and rejects a
mismatch — the same compare-and-swap `persistPtyBinding` already performs for
`expectedBinding`. A stale renderer cannot reach a successor pane or a reused
PTY id, which is invariants 1–4 of the original design, enforced rather than
asserted.

**Compatibility:** the ID-only channels stay for one release behind the existing
capability negotiation, since clients and hosts update independently. They are
marked deprecated, are not reachable from authoritative paths, and are deleted
in the release after — that deletion is where the LOC comes back.

## 3. One comparison, not twenty-six

```ts
export function bindingsEqual(a: PtyBinding, b: PtyBinding): boolean
export function sameNamespace(a: PtyBinding, b: PtyBinding): boolean
```

Delete the hand-rolled comparisons. `runtimeWorktreeIdsEqual` — the #12474 bug —
is one of them; ~26 repeat a host-id/namespace-id comparison inline. Each
hand-rolled copy is a future drift, and #12474 proves drift already happened.

## 4. Three-valued liveness

Landed (`5369479be29`). `hasPty: boolean | null`, `null` never authorizes
destruction.

## What this deletes

| Target                                                            | Est. LOC |
| ----------------------------------------------------------------- | -------: |
| ID-only IPC channels + handlers (release after next)              |     ~250 |
| Hand-rolled identity comparisons (~26 sites)                      |     ~180 |
| `pty-source-replay-index.ts` (done)                               |      201 |
| Inference sites that exist only because a binding was unavailable |     ~200 |

Net direction is negative once the deprecated channels go. It is net-positive in
the release that adds the type, and the recorded G6 decision permits that when
justified.

## What this deliberately does not build

No durable journal, no per-consumer cumulative cursors, no cryptographic device
principals, no parallel authority service. Verified against mature prior art:
bounded replay plus lifecycle-in-the-attach-reply is what shipping systems use,
and their entire persistent-terminal subsystem is ~6,500 LOC.

If a reviewer can name a concrete event sequence where bounded replay loses or
double-applies an outcome, that conclusion changes. Nobody has yet.

## How each claim gets falsified

| Claim                                    | Oracle                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| A stale op cannot reach a successor pane | Send a captured binding after the pane is recreated; must be refused   |
| A stale op cannot reach a reused pty id  | Same, after incarnation change                                         |
| Same-path workspaces do not collide      | The 5 skipped tests in `workspace-namespace-terminal-identity.test.ts` |
| Reattach never creates                   | Proven, discriminating (`ed10a467883`)                                 |
| Unknown never destroys                   | Revert three-valued `hasPty`; daemon spec reddens                      |

Every row must fail with its guard removed, verified under an isolated
`TMPDIR` — the e2e harness keys its seeded-repo pointer on a machine-global
tmpdir path, so a shared machine can both fabricate and mask a red.
