import type { BetterAuthOptions } from 'better-auth';
import type { DLogger } from '@dbos-inc/dbos-sdk';

const operations = {
  membership_reserve_failed: 'membership.reserve',
  membership_publish_failed: 'membership.publish',
  membership_terminalize_failed: 'membership.terminalize',
  membership_release_failed: 'membership.release',
  membership_finalize_failed: 'membership.finalize',
  membership_cancel_failed: 'membership.cancel',
  recovery_start_failed: 'recovery.start',
  better_auth_diagnostic: 'better_auth',
  dbos_diagnostic: 'workflow_runtime',
  diagnostic_input_rejected: 'diagnostics',
} as const;

type DiagnosticCode = keyof typeof operations;
type NativeSeverity = 'debug' | 'info' | 'warn' | 'error';
export type MembershipDiagnosticStep = 'reserve' | 'publish' | 'terminalize' | 'release' | 'finalize' | 'cancel';

/** The only Auth diagnostic payload: closed primitives, never caller metadata.
 * Runtime checks also close the boundary to untyped SDK/JavaScript callers. */
export function emitAuthDiagnostic(code: DiagnosticCode, severity: NativeSeverity = 'error'): void {
  const admittedCode = typeof code === 'string' && Object.hasOwn(operations, code) ? code : 'diagnostic_input_rejected';
  const admittedSeverity =
    severity === 'debug' || severity === 'info' || severity === 'warn' || severity === 'error' ? severity : 'error';
  console[admittedSeverity]({
    code: admittedCode,
    operation: operations[admittedCode],
    severity: admittedSeverity,
  });
}

export function emitMembershipStepFailure(step: MembershipDiagnosticStep): void {
  emitAuthDiagnostic(`membership_${step}_failed`);
}

/** Better Auth keeps its existing warn threshold. Only its native severity is
 * admitted; the message and all remaining arguments are deliberately unread. */
export const authBetterAuthLogger = {
  level: 'warn',
  log(level, _message, ..._args) {
    emitAuthDiagnostic('better_auth_diagnostic', level);
  },
} satisfies NonNullable<BetterAuthOptions['logger']>;

/** DBOS delegates without filtering, including stack/cause/span metadata.
 * Preserve one emission per call and its severity without inspecting any input. */
export const authWorkflowLogger = {
  debug(_entry, _metadata) {
    emitAuthDiagnostic('dbos_diagnostic', 'debug');
  },
  info(_entry, _metadata) {
    emitAuthDiagnostic('dbos_diagnostic', 'info');
  },
  warn(_entry, _metadata) {
    emitAuthDiagnostic('dbos_diagnostic', 'warn');
  },
  error(_entry, _metadata) {
    emitAuthDiagnostic('dbos_diagnostic', 'error');
  },
} satisfies DLogger;
