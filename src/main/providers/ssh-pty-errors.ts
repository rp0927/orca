export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'
/** The output source must be re-established. The shell is still running — this
 *  is explicitly NOT expiry, because callers respawn on expiry. */
export const SSH_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_SOURCE_RESTORE_REQUIRED'

export function isSshSourceRestoreRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR)
}

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}
