import { useLayoutEffect, useRef, type RefObject } from 'react';
import { AuthButton as Button } from './button';
import { Badge } from '@rezics/ui/shadcn/badge';
import { m } from './paraglide/messages.js';
import { formatSecurityDate, securityDevice, type SecuritySession, type SecurityPasskey } from './security';
import type { SecurityTarget } from './security-reconciliation';

export type TargetRow = { kind: 'session'; row: SecuritySession } | { kind: 'passkey'; row: SecurityPasskey };
export function securityTargetRow(
  target: SecurityTarget,
  sessions: SecuritySession[],
  passkeys: SecurityPasskey[],
): TargetRow | null {
  if (target.kind === 'session') {
    const row = sessions.find((row) => row.id === target.id);
    return row ? { kind: 'session', row } : null;
  }
  const row = passkeys.find((row) => row.id === target.id);
  return row ? { kind: 'passkey', row } : null;
}
export function targetAdvice(selected: TargetRow | null) {
  return selected?.kind === 'session' ? selected.row.revoke : selected?.row.remove;
}

function TargetDescription({ selected, locale }: { selected: TargetRow; locale: string }) {
  if (selected.kind === 'passkey') {
    const { row } = selected;
    return (
      <div className="space-y-2 wrap-anywhere">
        <p className="font-semibold">{row.name.trim() || m.auth_security_passkey_unnamed()}</p>
        <p>
          {m.auth_security_created_at()}{' '}
          <time dateTime={row.created_at}>{formatSecurityDate(row.created_at, locale)}</time>
        </p>
        <p>
          {row.last_used_at ? (
            <>
              {m.auth_security_passkey_last_used()}{' '}
              <time dateTime={row.last_used_at}>{formatSecurityDate(row.last_used_at, locale)}</time>
            </>
          ) : (
            m.auth_security_passkey_never_used()
          )}
        </p>
      </div>
    );
  }
  const { row } = selected;
  const device = securityDevice(row.user_agent);
  const client =
    row.client_display_name?.trim() ||
    (row.client_id === 'login'
      ? m.auth_security_rezics_account()
      : row.client_id === 'rezics-website'
        ? m.auth_security_rezics()
        : row.client_id);
  return (
    <div className="space-y-2 wrap-anywhere">
      <p className="font-semibold">
        {device ? m.auth_security_device(device) : m.auth_security_unknown_device()}{' '}
        {row.current ? <Badge variant="secondary">{m.auth_security_this_device()}</Badge> : null}
      </p>
      <p>{client}</p>
      <p>
        {m.auth_security_created_at()}{' '}
        <time dateTime={row.created_at}>{formatSecurityDate(row.created_at, locale)}</time>
      </p>
      <p>
        {m.auth_security_expires_at()}{' '}
        <time dateTime={row.expires_at}>{formatSecurityDate(row.expires_at, locale)}</time>
      </p>
    </div>
  );
}

/** Nonmodal review: surrounding writes share the page's synchronous boundary. */
export function SecurityTargetReview({
  selected,
  locale,
  retry,
  confirm,
  cancel,
}: {
  selected: TargetRow;
  locale: string;
  retry: boolean;
  confirm: () => void;
  cancel: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    cancelButton.current?.focus();
  }, []);
  return (
    <section
      role="dialog"
      aria-labelledby="security-target-review-title"
      aria-describedby="security-target-consequence"
      className="auth-login-form rounded-lg border p-4 sm:p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <h2 id="security-target-review-title">
        {selected.kind === 'session' ? m.auth_security_review_session() : m.auth_security_review_passkey()}
      </h2>
      <TargetDescription selected={selected} locale={locale} />
      <div id="security-target-consequence">
        <p>
          {selected.kind === 'passkey'
            ? m.auth_security_passkey_remove_confirmation()
            : selected.row.current
              ? m.auth_security_current_consequence()
              : m.auth_security_session_consequence()}
        </p>
        {selected.kind === 'passkey' ? <p>{m.auth_security_passkey_removal_rule()}</p> : null}
        {retry ? <p>{m.auth_security_retry_explanation()}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button ref={cancelButton} type="button" variant="outline" onClick={cancel}>
          {m.auth_inventory_cancel()}
        </Button>
        <Button type="button" onClick={confirm}>
          {selected.kind === 'session' ? m.auth_security_confirm_session() : m.auth_security_confirm_passkey()}
        </Button>
      </div>
    </section>
  );
}

export type TargetRecoveryPhase = 'accepted' | 'unknown' | 'present' | 'truncated' | 'unavailable';
export function SecurityTargetRecovery({
  target,
  phase,
  reading,
  selected,
  locale,
  retryAllowed,
  statusRef,
  check,
  review,
}: {
  target: SecurityTarget;
  phase: TargetRecoveryPhase;
  reading: boolean;
  selected: TargetRow | null;
  locale: string;
  retryAllowed: boolean;
  statusRef: RefObject<HTMLDivElement | null>;
  check: () => void;
  review: () => void;
}) {
  const session = target.kind === 'session';
  const message = reading
    ? m.auth_security_target_checking()
    : phase === 'accepted'
      ? m.auth_security_action_accepted()
      : phase === 'present'
        ? session
          ? m.auth_security_session_present()
          : m.auth_security_passkey_present()
        : phase === 'truncated'
          ? m.auth_security_target_incomplete()
          : phase === 'unavailable'
            ? m.auth_security_readback_unavailable()
            : session
              ? m.auth_security_session_unknown()
              : m.auth_security_passkey_unknown();
  return (
    <section className="auth-login-form rounded-lg border p-4 sm:p-6" aria-busy={reading}>
      <h2>{session ? m.auth_security_review_session() : m.auth_security_review_passkey()}</h2>
      <div ref={statusRef} tabIndex={-1} role="status">
        {message}
      </div>
      {phase === 'present' && !reading && selected ? <TargetDescription selected={selected} locale={locale} /> : null}
      <Button type="button" variant="outline" onClick={check} disabled={reading} aria-busy={reading}>
        {m.auth_security_check_current()}
      </Button>
      {phase === 'present' && !reading ? (
        <>
          {retryAllowed ? (
            <Button type="button" variant="outline" onClick={review}>
              {m.auth_security_retry_action()}
            </Button>
          ) : (
            <p>
              {targetAdvice(selected) === 'last-credential'
                ? m.auth_security_passkey_last_credential()
                : m.auth_inventory_unavailable()}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
