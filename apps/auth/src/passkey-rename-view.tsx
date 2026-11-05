import { useRef, useState } from 'react';
import { AuthButton as Button } from './button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from './paraglide/messages.js';
import { createPasskeyRename, renamePasskey } from './passkey-rename';
import { reviewPasskeyRegistration } from './security';
import type { SecurityPasskey } from './security';

export type PasskeyRenameLease = {
  signal: AbortSignal;
  isCurrent(): boolean;
  record(unknown: boolean): void;
  finish(): void;
};

export function PasskeyRenameView({
  accountId,
  passkey,
  disabled,
  begin,
  observe,
}: {
  accountId: string;
  passkey: SecurityPasskey;
  disabled: boolean;
  begin(): PasskeyRenameLease | null;
  observe(id: string, name: string | null): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [state, setState] = useState<'draft' | 'sending' | 'unknown' | 'reading'>('draft');
  const [notice, setNotice] = useState('');
  const lease = useRef<PasskeyRenameLease | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function submit() {
    if (state !== 'draft') return;
    const command = createPasskeyRename(accountId, passkey.id, name);
    if (!command) {
      setNotice(m.auth_security_passkey_rename_invalid());
      return;
    }
    const owned = begin();
    if (!owned) return;
    lease.current = owned;
    setState('sending');
    setNotice('');
    const result = await renamePasskey(command, owned.signal, () => owned.record(true));
    if (!owned.isCurrent()) return;
    if (result.kind === 'unknown') {
      setState('unknown');
      setNotice(m.auth_security_passkey_rename_unknown());
      return;
    }
    owned.record(false);
    owned.finish();
    lease.current = null;
    setState('draft');
    if (result.kind === 'acknowledged') {
      observe(result.id, result.name);
      setEditing(false);
      setNotice(m.auth_security_passkey_rename_saved());
    } else
      setNotice(
        result.kind === 'step-up' ? m.auth_security_passkey_rename_step_up() : m.auth_security_passkey_rename_failed(),
      );
  }
  async function review() {
    const owned = lease.current;
    if (!owned?.isCurrent()) return;
    setState('reading');
    const current = await reviewPasskeyRegistration(accountId, owned.signal);
    if (!owned.isCurrent()) return;
    if (current.kind !== 'ready') {
      setState('unknown');
      setNotice(m.auth_security_passkey_rename_review_failed());
      return;
    }
    const row = current.passkeys.find((row) => row.id === passkey.id);
    // A current label is an observation, not the lost command's acknowledgement.
    owned.finish();
    lease.current = null;
    setState('draft');
    setEditing(false);
    if (row) setName(row.name);
    setNotice(
      row ? m.auth_security_passkey_rename_observed({ name: row.name }) : m.auth_security_passkey_rename_history(),
    );
    observe(passkey.id, row?.name ?? null);
  }
  return (
    <div className="flex max-w-full flex-col items-start gap-2">
      {editing ? (
        <div className="flex max-w-full flex-col gap-2">
          <label htmlFor={`passkey-rename-${passkey.id}`}>{m.auth_security_passkey_rename_label()}</label>
          <Input
            ref={input}
            id={`passkey-rename-${passkey.id}`}
            value={name}
            maxLength={128}
            disabled={state !== 'draft'}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {state === 'unknown' || state === 'reading' ? (
            <Button type="button" variant="outline" disabled={state === 'reading'} onClick={() => void review()}>
              {m.auth_security_passkey_rename_review()}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                disabled={state === 'sending' || disabled}
                aria-busy={state === 'sending'}
                onClick={() => void submit()}
              >
                {m.auth_security_passkey_rename_save()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={state === 'sending'}
                onClick={() => {
                  setEditing(false);
                  setName(passkey.name);
                }}
              >
                {m.auth_security_passkey_rename_cancel()}
              </Button>
            </>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setName(passkey.name);
            setEditing(true);
            setNotice('');
            queueMicrotask(() => input.current?.focus());
          }}
        >
          {m.auth_security_passkey_rename()}
        </Button>
      )}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
