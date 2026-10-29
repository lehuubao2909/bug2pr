/**
 * Harness policy for computer-use pending_safety_checks. The generic
 * per-action confirmation is accepted only while the browser is on our own
 * sandboxed app (file:// or localhost). Any other check code, or any other
 * origin, stops the run so a person can review it.
 */
export type SafetyCheck = { id: string; code: string; message: string };

const ACKABLE_CODES = new Set(['computer_action_requires_confirmation']);

export function isSandboxedUrl(url: string): boolean {
  return url.startsWith('file://') || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

export function canAcknowledge(checks: SafetyCheck[], url: string): boolean {
  return checks.every((c) => isSandboxedUrl(url) && ACKABLE_CODES.has(c.code));
}
