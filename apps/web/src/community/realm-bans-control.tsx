import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import type { BanReadState, BanWriteInput, BanWriteResult } from './realm-bans';

export type RealmBansControlProps = {
  realmId: string;
  initial?: BanReadState;
  ready: boolean;
  read: (cursor?: string) => Promise<BanReadState>;
  write: (input: BanWriteInput) => Promise<BanWriteResult>;
};

/** Native acceptance is distinct from completion of Accounts' membership removal. */
export function RealmBanOutcome({ result }: { result: Extract<BanWriteResult, { ok: true }> }) {
  return (
    <div role="status" className="space-y-2 rounded-xl bg-muted p-4 text-sm">
      <p className="break-all font-medium">{result.action === 'ban' ? result.ban.accountId : result.accountId}</p>
      <p>{result.action === 'ban' ? m.realm_bans_active() : m.realm_bans_lifted()}</p>
      {result.action === 'ban' && result.ban.workflowId !== null ? <p>{m.realm_bans_removal_pending()}</p> : null}
    </div>
  );
}

function readMessage(state: Exclude<BanReadState['state'], 'ready'>) {
  switch (state) {
    case 'loading':
      return m.realm_bans_loading();
    case 'signed-out':
      return m.realm_bans_signed_out();
    case 'forbidden':
      return m.realm_bans_forbidden();
    case 'closed':
      return m.realm_bans_closed();
    case 'invalid-cursor':
      return m.realm_bans_cursor_invalid();
    case 'unavailable':
      return m.realm_bans_unavailable();
  }
}

function writeMessage(reason: Extract<BanWriteResult, { ok: false }>['reason']) {
  switch (reason) {
    case 'signed-out':
      return m.realm_bans_signed_out();
    case 'forbidden':
      return m.realm_bans_forbidden();
    case 'closed':
      return m.realm_bans_closed();
    case 'role-required':
      return m.realm_bans_role_required();
    case 'conflict':
      return m.realm_bans_conflict();
    case 'invalid':
      return m.realm_bans_invalid();
    case 'unavailable':
      return m.realm_bans_write_unavailable();
  }
}

/** A complete Realm management region, composed from shadcn fields and buttons; no registry equivalent exists. */
export function RealmBansControl({ realmId, initial, ready, read, write }: RealmBansControlProps) {
  const id = useId();
  const [view, setView] = useState<BanReadState>(initial ?? { state: 'loading' });
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [result, setResult] = useState<BanWriteResult | null>(null);
  const [retry, setRetry] = useState<BanWriteInput | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(
    async (cursor?: string) => {
      const current = ++generation.current;
      setView({ state: 'loading' });
      let next: BanReadState;
      try {
        next = await read(cursor);
      } catch {
        next = { state: 'unavailable' };
      }
      if (generation.current === current) {
        setView(next);
        if (next.state === 'forbidden' || next.state === 'closed' || next.state === 'signed-out') {
          setResult(null);
          setConfirm(null);
        }
      }
    },
    [read],
  );

  useEffect(() => {
    if (initial === undefined) void refresh();
    return () => {
      generation.current++;
    };
  }, [initial, refresh]);

  async function change(input: BanWriteInput) {
    if (!ready || working.current || view.state !== 'ready') return;
    working.current = true;
    setBusy(true);
    setResult(null);
    let next: BanWriteResult;
    try {
      next = await write(input);
    } catch {
      next = { ok: false, reason: 'unavailable' };
    }
    setResult(next);
    setRetry(!next.ok && next.reason === 'unavailable' ? input : null);
    if (next.ok) {
      setConfirm(null);
      if (input.action === 'ban') {
        setAccountId('');
        setReason('');
      }
      await refresh();
    } else if (next.reason === 'forbidden' || next.reason === 'signed-out' || next.reason === 'closed') {
      setView({ state: next.reason });
      setConfirm(null);
    }
    working.current = false;
    setBusy(false);
  }

  const disabled = !ready || busy || retry !== null;
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-5" aria-busy={busy || view.state === 'loading'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {m.realm_bans_heading()}
        </h2>
        <Button
          type="button"
          variant="outline"
          disabled={busy || view.state === 'loading' || retry !== null}
          onClick={() => {
            setConfirm(null);
            void refresh();
          }}
        >
          {m.realm_bans_refresh()}
        </Button>
      </div>
      {view.state !== 'ready' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {readMessage(view.state)}
        </p>
      ) : (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{m.realm_bans_help()}</p>
          <form
            className="max-w-xl space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled)
                void change({
                  realmId,
                  accountId: accountId.trim(),
                  reason,
                  action: 'ban',
                  idempotencyKey: crypto.randomUUID(),
                });
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-account`}>{m.realm_bans_account()}</FieldLabel>
              <Input
                id={`${id}-account`}
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={36}
                pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
                value={accountId}
                disabled={disabled}
                onChange={(event) => setAccountId(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>{m.realm_bans_reason()}</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                maxLength={1024}
                value={reason}
                disabled={disabled}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={disabled || !accountId.trim()}>
              {m.realm_bans_ban()}
            </Button>
          </form>
          <h3 className="font-semibold">{m.realm_bans_current()}</h3>
          {view.page.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.realm_bans_empty()}</p>
          ) : (
            <ul className="divide-y">
              {view.page.items.map((ban) => (
                <li key={ban.accountId} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 basis-56 space-y-1">
                      <p className="break-all text-sm font-medium">{ban.accountId}</p>
                      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                        {ban.reason || m.realm_bans_no_reason()}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setConfirm(ban.accountId)}
                    >
                      {m.realm_bans_unban()}
                    </Button>
                  </div>
                  {confirm === ban.accountId ? (
                    <div className="space-y-3 rounded-xl bg-muted p-4">
                      <p className="max-w-prose text-sm">{m.realm_bans_unban_confirm()}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            void change({
                              realmId,
                              accountId: ban.accountId,
                              reason: '',
                              action: 'unban',
                              idempotencyKey: crypto.randomUUID(),
                            })
                          }
                        >
                          {m.realm_bans_confirm()}
                        </Button>
                        <Button type="button" variant="ghost" disabled={disabled} onClick={() => setConfirm(null)}>
                          {m.realm_bans_cancel()}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {view.page.next ? (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setConfirm(null);
                void refresh(view.page.next ?? undefined);
              }}
            >
              {m.realm_bans_next()}
            </Button>
          ) : null}
        </>
      )}
      {result?.ok && (view.state === 'ready' || view.state === 'loading' || view.state === 'unavailable') ? (
        <RealmBanOutcome result={result} />
      ) : null}
      {result && !result.ok ? (
        <div role="alert" className="space-y-3 text-sm">
          <p>{writeMessage(result.reason)}</p>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !ready || view.state !== 'ready'}
              onClick={() => void change(retry)}
            >
              {m.realm_bans_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
