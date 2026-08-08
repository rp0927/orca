# Goalposts and proof contract

This file answers one question: **what exact evidence is required before an
agent may write “proven”?**

The current status is frozen at **0/8 proven goalposts** and **0/13 proven
journeys**. Status may change only from evidence produced on the same rebased,
converged release candidate. Historical snapshot tests and independently useful
narrow PRs may be cited as partial evidence but cannot promote a row.

## Recorded user decisions

These amend the contract above. Only the user may add to this list.

### D1 — G6 relaxed from strictly net-negative (2026-08-07)

> "It's okay if we must increase LOC but try not to."

G6's pass condition is no longer a strict inequality against the frozen
baseline. It is now: **minimise added production code, and justify every net
addition against the correctness it buys.** A net-positive total does not fail
G6 on its own; an unjustified one does.

Why this was needed: the deletion budget the plan assumed does not exist. An
entrypoint-rooted import graph over all 20 real build entrypoints found that
51 of the 53 candidate files in `src/relay/*pty-source-*`,
`src/shared/pty-consumer-*`, and `src/main/ipc/ssh-pty-*` are reachable and
value-instantiated on live paths. Only 2 files (263 LOC) are unreachable, and 2
of the candidates did not exist at the baseline so deleting them earns no
credit. Against roughly +1,021 LOC to offset, a strict inequality was not
reachable without deleting load-bearing code — which the governing rule forbids.

Still binding: correctness may not be weakened to reduce line count, and a
replacement architecture added beside the old one does not earn its lines.

## Universal proof rule

A gate is `proven` only when both exist:

1. the complete behavior is reachable through every named production path; and
2. the named proof exercises that behavior and its failure boundaries on the
   final candidate.

Every proof receipt must record:

- candidate commit SHA and exact merge base;
- unfixed baseline SHA used for red/green discrimination;
- exact command or manual journey protocol;
- OS, architecture, filesystem, runtime, Git, SSH, daemon, relay, client, and
  host versions relevant to that journey;
- UTC start/end time, exit status, counts, and artifact/log location;
- the production caller, persistence boundary, transport, and cleanup path
  exercised;
- the expected oracle and the observed result; and
- independent reviewer identity and unresolved-finding count.

For a new regression oracle, demonstrate that it fails for the intended reason
on the unfixed baseline and passes on the candidate. A test that passes both is
a forward guard and cannot prove the fix.

## G0 — One design contract

**Current status: partial.**

G0 is proven only when:

- every reachable production path follows one reconciled identity, host
  boundary, operations, delivery, migration, compatibility, and minimal-shape
  contract;
- there is one final-host authority service, thin transport adapters, one app
  projection/controller, and one bounded pre-cutover legacy importer;
- no adapter or renderer owns a parallel authority state machine;
- all retained existing primitives are mapped by semantics, not similar names;
- the lost-consumer/compaction liveness gap has a safe, bounded, authenticated,
  operator-reachable resolution that does not infer death from time; and
- an independent production-graph audit finds no contradictory path.

The design document alone, a behavior contract, or focused tests do not prove
G0.

## G1 — One final-host authority

**Current status: partial.**

G1 is proven only when local, daemon, WSL, direct SSH, nested SSH, paired
runtime, and remote server all resolve:

- a stable identity minted or validated by the final PTY-owning host;
- a canonical host-local namespace for worktree, folder, and floating
  workspaces;
- one exact pane-generation/PTY-incarnation binding;
- host connections keyed by final-host identity with lazy discovery;
- concurrent host isolation; and
- namespace-local admission, failure, grant, handover, and retirement.

`connectionId`, SSH target ID, client repository ID, path spelling, or
`worktreeId` may be routing metadata. Their existing names and usage counts are
not proof that they satisfy final-host identity or namespace semantics.

Proof requires the applicable live journeys below, including simultaneous hosts
and independent client/host updates.

## G2 — Exact operations only

**Current status: partial.**

G2 is proven only when input, resize, signal, close, output, and exit are fenced
by the full binding captured before any await:

- authority host;
- namespace;
- pane generation;
- owner/writer incarnation;
- physical PTY;
- PTY incarnation; and
- negotiated operation/source generation where applicable.

Stale, partial, absent, timed-out, disconnected, or unknown evidence must not
affect a successor. An authoritative operation must never retry through an
ID-only provider call or a legacy mutation path.

Proof must cover all operations across local, daemon, WSL, SSH, paired runtime,
remote server, renderer fallback, restart, concurrent replacement, and both
mixed-version directions. Store-row counts and source-text assertions are not
sufficient.

## G3 — Durable ordered delivery

**Current status: partial.**

G3 is proven only when the final production design provides all observable
properties below, even if its internal mechanism differs from the preserved
construction design:

- complete boundary snapshot before later events;
- producer held while boundary/replay is established;
- contiguous replay before reconciliation and live resume;
- durable semantic outcomes, including exit and state needed by a newly
  attached consumer;
- durable idempotent main-process projection before acknowledgement;
- final-host-owned cumulative acknowledgement or an explicitly approved
  equivalent with the same crash/replay guarantees;
- renderer snapshot-plus-delta observation;
- app, renderer, host, and transport restart resume;
- gap detection and resnapshot without silent omission;
- bounded memory, queues, pages, listeners, timers, and retained output;
- independent consumer retirement and safe compaction liveness; and
- no app-side duplicate cursor, settlement, receipt, or suffix-reconciliation
  authority.

Proof must include crash-before/after-ACK cuts, lost responses, disconnected
replay, gap recovery, slow/stalled consumers, retired and permanently lost
consumers, paired/remote restart, mixed versions, and scale.

## G4 — One-way legacy cutover

**Current status: partial.**

G4 is proven only when each namespace performs, in order:

1. explicit capability negotiation;
2. a brief legacy-write freeze;
3. exact non-mutating inventory;
4. a deterministic import plan;
5. validation with ambiguity kept visible and non-destructive;
6. one self-contained durable authority commit;
7. topology attachment; and
8. exact client opening through the authoritative path.

There must be no dual writer, destructive inference, authority-to-legacy
fallback, or second durable migration catalog after cutover. Old peers remain
on an unchanged isolated legacy surface or fail before mutation.

Proof requires crash cuts at every phase, replay from the self-contained commit,
ambiguous-row isolation, independent namespace failure, and legacy-writer and
reconciliation deletion.

## G5 — Wire and platform compatibility

**Current status: not started.**

G5 is proven only when all exchanged changes follow the remote-wire
compatibility contract and the final candidate passes:

- old client to new host;
- new client to old host;
- native macOS;
- native Linux at Ubuntu 20.04 / glibc 2.31 compatibility floor;
- native Windows;
- physical WSL, including Git Bash/`.cmd` boundaries where relevant;
- Docker OpenSSH;
- daemon;
- direct and nested SSH;
- paired runtime;
- remote server;
- git worktree;
- folder workspace;
- floating workspace; and
- drive-letter and UNC namespace paths.

Run both skew directions independently across every changed deployment boundary:
app↔daemon, app↔SSH relay/final host, paired client↔paired runtime, remote
client↔remote server, and mobile/E2EE RPC where affected. A single in-process
codec test or one client/host pairing cannot stand in for this matrix.

New opcodes or semantics require explicit capability negotiation. An optional
field that parses on an old peer does not by itself prove that old behavior
remains correct.

Mocking `process.platform`, running Linux inside Docker, or passing in-process
wire unit tests does not prove the corresponding native or live-skew row.

## G6 — Simpler, strictly smaller production code

**Current status: partial; final size condition currently fails.**

The user has tightened this gate: the final integrated program must contain
strictly less production source than its frozen pre-program baseline.

The default baseline is
`5ed45739e94bdf6460364e033bfcec9b32c0b42a`, the base recorded by GitHub for
PR #12600. This broader program subsumes #12600. Changing the baseline requires
an explicit user decision recorded before more implementation begins.

G6 is proven only when:

- aggregate program-attributable production source net LOC is **less than
  zero** against the frozen baseline;
- every program-attributable prerequisite merged after the baseline and every
  stacked PR is included, even if a later rebase places it in `main`;
- overlapping changes are recomputed from the frozen baseline to the final tree
  so additions and later deletions are not double-counted;
- unrelated upstream or user deletions cannot offset program additions;
- production, test, documentation, CI/runner, generated, and vendored changes
  are reported separately;
- every new production module is reachable from a real entrypoint;
- no test fixture remains under production compilation;
- there is one identity comparison, transition implementation, exact-operation
  client, mutation admission path, and delivery state machine;
- no re-export shim or one-type module exists solely to preserve construction
  layering;
- no superseded quarantine, sliding-window, retry-verdict, reconciliation,
  duplicate cursor, receipt ledger, legacy writer, or migration bridge remains
  reachable after cutover; and
- an independent reachability and duplicate-state-machine audit is clean.

Tests or docs cannot offset positive production LOC. A smaller narrow PR is not
proof if the final stack remains net positive. Deleting correctness or platform
coverage to hit the number is prohibited.

Classify by behavior, not directory name: shipped runtime code, migration code,
and build-time code that enforces a shipped artifact invariant are production;
test-only runners and fixtures are tests even when misplaced, and their presence
under production compilation independently fails this gate. Publish the final
file-by-file classification so the count cannot be moved between buckets.

## G7 — No regression and reviewable comprehensive change

**Current status: not started.**

G7 is proven only on the rebased, converged candidate after G0–G6 and all
thirteen journeys are proven. It requires:

- correctness and security gates;
- A/B input latency and output throughput;
- backpressure and bounded-memory results;
- renderer/app/daemon/relay restore and startup results;
- large-pane, long-session, and multi-host scale results;
- native packaging/startup on macOS, Linux, and Windows;
- WSL, Docker SSH, paired, remote, folder, floating, worktree, drive, and UNC
  coverage;
- both live mixed-version directions;
- final categorized LOC census;
- independent repository review with no unresolved P0–P2 findings;
- release-readiness review with no unresolved correctness, security,
  compatibility, or performance findings; and
- a detailed comprehensive PR whose claims match the receipts.

Before implementation, record a performance protocol that makes “no
regression” falsifiable:

- fixed candidate and baseline builds, hardware, OS, power mode, network shape,
  pane/session population, payloads, and background-load policy;
- warm-up policy, randomized A/B order, sample count, raw-data location, and
  statistical method;
- input latency, output throughput, memory, backpressure, restore, startup, and
  large-pane metrics with directionality;
- deterministic ceilings for writes, scans, queues, listeners, timers, and
  allocations on hot paths; and
- a predeclared equivalence/no-regression bound no larger than measured baseline
  noise. A nonzero bound handles measurement noise; it is not permission for a
  known slowdown and requires explicit user approval.

Unless an independently reviewed protocol justifies another count, use at least
five warm-up trials and thirty measured trials per latency/startup/restore
configuration, retain raw samples, and report confidence intervals. Throughput,
backpressure, and memory tests must also include a fixed-duration steady-state
run and a leak-slope result. Choose all workloads and thresholds before looking
at candidate results.

Green CI, thousands of tests, mergeability, or “reviewable for what shipped” do
not prove G7.

## Thirteen required production journeys

Every row is currently **not proven**.

The issue-to-journey matrix in
[`related-open-work.md`](./related-open-work.md#mandatory-issue-to-journey-matrix)
is part of these journeys, not optional context. Every bound incident needs a
red-on-baseline/green-on-candidate oracle, or explicit evidence plus user
acceptance that it is unrelated.

|   # | Journey                                               | Required oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --: | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Local macOS, Linux, and Windows                       | The same pane, full binding, and OS process survive renderer and app restart; every stale exact operation is rejected. Run natively on all three OSes.                                                                                                                                                                                                                                                                                                                 |
|   2 | Daemon and physical WSL                               | The same PTY survives client and daemon reconnect/restart boundaries; generation skew fails closed without killing or replacing a live successor.                                                                                                                                                                                                                                                                                                                      |
|   3 | Lazy discovery and skipped-host restart               | An unused host is not probed eagerly. After a restart that skipped it, lazy rediscovery restores only that host's sessions and never adopts host-current or sibling-host state.                                                                                                                                                                                                                                                                                        |
|   4 | Concurrent multi-host connections                     | At least two distinct final-host connections operate simultaneously. One host's disconnect, CAS, timeout, or failure cannot affect the other.                                                                                                                                                                                                                                                                                                                          |
|   5 | Namespace-partial admission failure                   | One namespace on a multiplexed connection fails challenge/CAS/grant publication while another commits. Only the failed host-plus-namespace is fenced.                                                                                                                                                                                                                                                                                                                  |
|   6 | Docker OpenSSH with `MaxSessions=1`                   | The same remote PID and exact binding survive disconnect and client restart. Authority restart imports exactly or exposes unresolved recovery without creating, killing, or adopting. Explicit close or exact proven teardown durably retires the lease and process; unknown ownership stays visible and recoverable rather than being killed. Count actual remote processes, panes, tabs, bindings, leases, and session-cap slots before and after a settle interval. |
|   7 | Two independent Docker SSH hosts                      | Two simultaneous final hosts keep endpoint credentials, principals, namespaces, sessions, cursors, failures, and cleanup completely isolated.                                                                                                                                                                                                                                                                                                                          |
|   8 | Paired client and remote server                       | The final host remains authoritative across independently updated peers, pairing reconnect, client restart, and remote-runtime restart.                                                                                                                                                                                                                                                                                                                                |
|   9 | Worktree, folder, floating, drive, and UNC namespaces | Each resolves the same stable host-local namespace across spelling/restart changes, without using client repository ID or target ID as identity.                                                                                                                                                                                                                                                                                                                       |
|  10 | Stable proof and exact retry                          | One bounded device proof identity admits fresh process/session nonces. A lost response retries the exact challenge/request; changed, replayed, cross-host, cross-namespace, or host-current state is rejected.                                                                                                                                                                                                                                                         |
|  11 | Identity reset and re-enrollment                      | Crash-resumable host retirement, relay revoke acknowledgement, transport closure, local credential removal, and atomic successor publication occur in order. Offline and old peers remain explicitly pending.                                                                                                                                                                                                                                                          |
|  12 | Mixed versions in both directions                     | No unknown opcode or ungranted publication mutates state. Unsupported challenge, grant, delivery, or operation semantics stay on isolated legacy behavior or fail before mutation.                                                                                                                                                                                                                                                                                     |
|  13 | Performance and scale                                 | Under the predeclared protocol above, input/output latency, throughput, backpressure, memory, reconnect/restore, startup, large-pane, long-session, and multi-host ceilings show no regression against the fixed baseline. Raw samples, confidence intervals, deterministic counters, and leak slopes satisfy their predeclared bounds.                                                                                                                                |

## Cross-cutting correctness cases

Every relevant journey must exercise:

- stale, missing, unknown, rejected, timed-out, and disconnected evidence;
- concurrent replacement and sibling-host/namespace isolation;
- lost request and lost response;
- cancellation and partial setup cleanup;
- crash immediately before and after every durable boundary;
- restart from disk rather than process-memory state;
- duplicate and out-of-order delivery;
- gaps, overflow, and slow/stalled consumers;
- explicit close versus detach;
- eventual exact retirement after explicit close or proven teardown while
  uncertain ownership remains intact and visible;
- legacy data with missing optional fields;
- relay/daemon incarnation reuse;
- sleep/resume and clock movement where timers schedule retries;
- exact remote process/PID census, not only persisted-row state; and
- cleanup that requires positive identity proof.

## Forbidden proof substitutions

- A mock is not a native-platform journey.
- A source grep is not a production call-path journey.
- A row marked `expired` is not proof that its remote process exited.
- Optional pane metadata plus an O(n) repair scan is not structural uniqueness.
- An empty list from an unavailable provider is not proof of absence.
- A timer or retry budget is not proof of death.
- A broad test count is not a correctness oracle.
- A test that passes unfixed code is not evidence that a change fixed the bug.
- An open or green PR is not shipped behavior.
- Historical construction receipts are not proof for a rebased candidate.
- Prior art or an uncited LOC comparison cannot delete a requirement.

## Promotion template

Before changing any row to `proven`, add a receipt containing:

```text
Gate or journey:
Candidate SHA:
Merge-base SHA:
Unfixed/red SHA:
Production path exercised:
Exact command or manual protocol:
Environment and versions:
Expected oracle:
Red result:
Green result:
UTC start/end:
Artifact/log:
Independent reviewer:
Unresolved P0/P1/P2:
LOC/performance impact:
```

If any field is missing, the row remains partial or not started.
