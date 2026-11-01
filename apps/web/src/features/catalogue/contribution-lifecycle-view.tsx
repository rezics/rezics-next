import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import type {
  ContributionAddress,
  ContributionAvailability,
  ContributionCommand,
  ContributionFailure,
  ContributionTransport,
} from './contribution-lifecycle';

/** Mounted only for the exact candidate returned by this session's successful native proposal.
 * The affordance is not authorization: both native operations recheck the original author and current grants.
 */
export const ContributionLifecycle = catalogueEditor(ContributionLifecycleLive);

function ContributionLifecycleLive({
  address,
  locale,
  transport,
  onClear,
}: {
  address: ContributionAddress;
  locale: string;
  transport: ContributionTransport;
  onClear: () => void | Promise<void>;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [state, setState] = useState<'active' | 'deleted' | 'restored' | 'expired'>('active');
  const [confirmation, setConfirmation] = useState<ContributionCommand['operation'] | null>(null);
  const [failure, setFailure] = useState<ContributionFailure['reason']>();
  const [current, setCurrent] = useState<ContributionAvailability>();
  const [busy, setBusy] = useState(false);
  const [needsRead, setNeedsRead] = useState(false);
  const pending = useRef<ContributionCommand | null>(null);
  const running = useRef(false);
  const session = useRef(address.session);
  const operation = state === 'deleted' ? 'restore' : 'delete';
  const action = operation === 'delete' ? m.contribution_withdraw({}, o) : m.contribution_restore({}, o);

  async function change() {
    if (!lifetime.active()) return;
    if (running.current || needsRead || state === 'expired' || (!confirmation && !pending.current)) return;
    pending.current ??= {
      ...address,
      operation: confirmation!,
      key: crypto.randomUUID(),
      ...(session.current ? { session: session.current } : {}),
    };
    running.current = true;
    setBusy(true);
    setConfirmation(null);
    setFailure(undefined);
    try {
      const result = await transport.change(pending.current);
      if (!lifetime.active()) return;
      if (!result.ok) {
        setFailure(result.reason);
        if (result.reason !== 'unavailable') {
          pending.current = null;
          setConfirmation(null);
        }
        if (result.reason === 'expired') setState('expired');
        if (result.reason === 'conflict') setNeedsRead(true);
        if (result.reason === 'denied') {
          setCurrent(undefined);
          await onClear();
          if (!lifetime.active()) return;
        }
        return;
      }
      pending.current = null;
      setConfirmation(null);
      session.current = result.session ?? session.current;
      setCurrent(result.current);
      setState(result.operation === 'delete' ? 'deleted' : 'restored');
      if (result.operation === 'delete') await onClear();
      if (!lifetime.active()) return;
    } catch {
      if (!lifetime.active()) return;
      setFailure('unavailable');
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    if (!lifetime.active()) return;
    if (running.current || pending.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.read({ ...address, ...(session.current ? { session: session.current } : {}) });
      if (!lifetime.active()) return;
      session.current = next.session ?? session.current;
      setCurrent(next);
      if (next.subject === 'available' && next.candidate !== 'unconfirmed') {
        setNeedsRead(false);
        setFailure(undefined);
        if (next.candidate === 'deleted') setState('deleted');
      }
    } catch {
      if (!lifetime.active()) return;
      setCurrent({ subject: 'unavailable', candidate: 'unconfirmed', selected: null });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={m.contribution_title({}, o)}
      aria-busy={busy}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <h2 className="text-xl font-semibold">{m.contribution_title({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.contribution_intro({}, o)}</p>
      {busy && <p role="status">{m.contribution_loading({}, o)}</p>}
      {state !== 'active' && (
        <p role="status">
          {state === 'deleted'
            ? m.contribution_deleted({}, o)
            : state === 'expired'
              ? m.contribution_expired({}, o)
              : m.contribution_restored({}, o)}
        </p>
      )}
      {state === 'deleted' && <p className="text-sm text-muted-foreground">{m.contribution_window({}, o)}</p>}
      {current && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            {current.subject === 'available'
              ? m.contribution_subject_available({}, o)
              : m.contribution_read_unavailable({}, o)}
          </p>
          <p>
            {current.candidate === 'deleted'
              ? m.contribution_tombstone({}, o)
              : current.candidate === 'available'
                ? m.contribution_candidate_available({}, o)
                : m.contribution_candidate_unconfirmed({}, o)}
          </p>
          {state === 'restored' && current.selected === false && <p>{m.contribution_unselected({}, o)}</p>}
        </div>
      )}
      {failure && (
        <p role="alert">
          {failure === 'denied'
            ? m.contribution_denied({}, o)
            : failure === 'expired'
              ? m.contribution_expired({}, o)
              : failure === 'invalid'
                ? m.contribution_invalid({}, o)
                : failure === 'conflict'
                  ? m.contribution_conflict({}, o)
                  : m.contribution_unavailable({}, o)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {state !== 'expired' && failure !== 'denied' && (
          <Button
            type="button"
            variant={operation === 'delete' ? 'destructive' : 'default'}
            disabled={busy || needsRead}
            onClick={() => {
              if (!lifetime.active() || running.current || needsRead) return;
              if (pending.current) void change();
              else {
                setFailure(undefined);
                setConfirmation(operation);
              }
            }}
          >
            {pending.current ? m.contribution_retry({}, o) : action}
          </Button>
        )}
        {(current || needsRead) && !pending.current && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
            {m.contribution_refresh({}, o)}
          </Button>
        )}
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => lifetime.active() && !open && setConfirmation(null)}
      >
        <AlertDialogContent initialFocus={() => lifetime.active()} finalFocus={() => lifetime.active()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{action}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === 'delete' ? m.contribution_confirm_delete({}, o) : m.contribution_confirm_restore({}, o)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.candidate_cancel({}, o)}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmation === 'delete' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() => void change()}
            >
              {m.contribution_confirm({}, o)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
