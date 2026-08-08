// Why this module exists: reattach failure used to converge on one action —
// spawn a fresh shell. A transport fault and a genuinely-gone session were
// indistinguishable at the decision point, so a transient error respawned the
// pane and resumed the same agent session a second time; both processes then
// appended to one transcript.
//
// Respawn now requires proof. Everything else is unresolved, which leaves the
// shell running and the binding intact for a later reattach.

/** The host said the session is gone. */
const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
/** The shell is alive; only its output source must be re-established. */
const SSH_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_SOURCE_RESTORE_REQUIRED'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True only when the failure proves the session no longer exists. Anything
 * unrecognized is unresolved, because a new failure mode must not silently
 * become a respawn.
 */
export function isProvenSshSessionGoneError(error: unknown): boolean {
  const message = messageOf(error)
  if (message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR)) {
    return false
  }
  return message.includes(SSH_SESSION_EXPIRED_ERROR) || /PTY ".+" not found/i.test(message)
}

/** Keeps wire tokens out of the pane; the shell is still running either way. */
export function describeReattachFailure(error: unknown): string {
  const message = messageOf(error)
  if (message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR)) {
    return 'Reconnecting this terminal — its output stream is being re-established.'
  }
  return message
}
