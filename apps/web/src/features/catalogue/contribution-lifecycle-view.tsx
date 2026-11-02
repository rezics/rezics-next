import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef, useState, type MouseEvent } from 'react';
import { useContributionResultFocus } from './contribution-result-focus';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
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
import {
  AuthoringDepartureBoundary,
  useAuthoringDeparture,
  type AuthoringLocation,
} from '../../threads/authoring-departure';
import { confirmedContributionOperation } from './contribution-lifecycle';
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
export const ContributionLifecycle = catalogueEditor(ContributionLifecycleWorkspace);

const contributionAddress = (location: AuthoringLocation) => JSON.stringify([location.pathname, location.search]);

function ContributionLifecycleWorkspace(props: Parameters<typeof ContributionLifecycleLive>[0]) {
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={contributionAddress}>
      <ContributionLifecycleLive {...props} />
    </AuthoringDepartureBoundary>
  );
}

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
  const resultFocus = useContributionResultFocus();
  const o = { locale: locale as never };
  const [state, setState] = useState<'active' | 'deleted' | 'restored' | 'expired'>('active');
  const [confirmation, setConfirmation] = useState<{ operation: ContributionCommand['operation'] } | null>(null);
  const [failure, setFailure] = useState<ContributionFailure['reason']>();
  const [current, setCurrent] = useState<ContributionAvailability>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<ContributionCommand | null>(null);
  const running = useRef(false);
  const session = useRef(address.session);
  const terminal = useRef<'denied' | 'expired' | null>(null);
  const operation = current ? confirmedContributionOperation(current) : 'delete';
  // Captured controls must consult the latest observation, including a retired confirmation.
  const controls = useRef({ operation, confirmation });
  controls.current = { operation, confirmation };
  // Reads and open confirmations carry no unresolved mutation. The sealed command alone owns recovery.
  const unresolved = () => lifetime.active() && pending.current !== null;
  const departure = useAuthoringDeparture(
    unresolved,
    unresolved,
    pending.current?.key ?? 'settled',
    undefined,
    () => {
      lifetime.retire();
      pending.current = null;
      running.current = false;
      controls.current.confirmation = null;
    },
    undefined,
    undefined,
    contributionAddress,
  );
  function settle() {
    pending.current = null;
    departure.release();
  }
  function clearConfirmation(expected?: { operation: ContributionCommand['operation'] }) {
    if (expected && controls.current.confirmation !== expected) return;
    controls.current.confirmation = null;
    setConfirmation(null);
  }
  const action = operation === 'delete' ? m.contribution_withdraw({}, o) : m.contribution_restore({}, o);

  function observe(next: ContributionAvailability, effect?: ContributionCommand['operation']) {
    session.current = next.session ?? session.current;
    setCurrent(next);
    const nextOperation = confirmedContributionOperation(next);
    controls.current.operation = nextOperation;
    clearConfirmation();
    if (!terminal.current) {
      if (nextOperation) setFailure(undefined);
      // A fresh read replaces old action assumptions. Only a confirmed command
      // can report restoration; availability alone says nothing about selection.
      setState(
        effect === 'restore' ? 'restored' : effect === 'delete' || nextOperation === 'restore' ? 'deleted' : 'active',
      );
    }
  }

  async function change(
    event: MouseEvent<HTMLButtonElement>,
    admission:
      | { kind: 'confirm'; confirmation: { operation: ContributionCommand['operation'] } }
      | { kind: 'retry'; command: ContributionCommand },
  ) {
    if (!lifetime.active()) return;
    const latest = controls.current;
    if (running.current || terminal.current) return;
    let command: ContributionCommand;
    if (admission.kind === 'retry') {
      if (pending.current !== admission.command) return;
      command = admission.command;
    } else {
      if (
        !latest.operation ||
        latest.operation !== admission.confirmation.operation ||
        latest.confirmation !== admission.confirmation ||
        pending.current
      )
        return;
      command = {
        ...address,
        operation: admission.confirmation.operation,
        key: crypto.randomUUID(),
        ...(session.current ? { session: session.current } : {}),
      };
      pending.current = command;
      clearConfirmation(admission.confirmation);
    }
    const focusIntent = resultFocus.start(event, lifetime.active);
    if (admission.kind === 'confirm') resultFocus.suppressCloseFocus.current = focusIntent !== null;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.change(command);
      if (!lifetime.active()) return;
      if (!result.ok) {
        setFailure(result.reason);
        if (result.reason !== 'unavailable') {
          settle();
          setConfirmation(null);
        }
        if (result.reason === 'expired' || result.reason === 'denied') terminal.current = result.reason;
        if (result.reason === 'expired') setState('expired');
        if (result.reason === 'conflict') {
          observe({ subject: 'unavailable', candidate: 'unconfirmed', selected: null });
        }
        if (result.reason === 'denied') {
          setCurrent(undefined);
          await onClear();
          if (!lifetime.active()) return;
        }
        return;
      }
      settle();
      setConfirmation(null);
      session.current = result.session ?? session.current;
      observe(result.current, result.operation);
      if (result.operation === 'delete') await onClear();
      if (!lifetime.active()) return;
    } catch {
      if (!lifetime.active()) return;
      // Callback failures after a confirmed effect/refusal cannot turn it into an uncertain command.
      if (pending.current) setFailure('unavailable');
    } finally {
      resultFocus.complete(focusIntent);
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    if (!lifetime.active()) return;
    if (running.current || pending.current) return;
    resultFocus.cancel();
    running.current = true;
    setBusy(true);
    controls.current.confirmation = null;
    setConfirmation(null);
    try {
      const next = await transport.read({ ...address, ...(session.current ? { session: session.current } : {}) });
      if (!lifetime.active()) return;
      observe(next);
    } catch {
      if (!lifetime.active()) return;
      observe({ subject: 'unavailable', candidate: 'unconfirmed', selected: null });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-label={m.contribution_title({}, o)} aria-busy={busy} className="min-w-0">
      <ContentItemFrame
        as="div"
        className="flex min-w-0 flex-col gap-5 rounded-xl bg-card p-4 [overflow-wrap:anywhere] sm:p-6"
      >
        <header className="flex min-w-0 flex-col gap-2">
          <ContentItemHeading level={2} className="text-xl font-semibold leading-snug">
            {m.contribution_title({}, o)}
          </ContentItemHeading>
          <p className="text-sm leading-relaxed text-muted-foreground">{m.contribution_intro({}, o)}</p>
        </header>
        {busy && (
          <p role="status" className="text-sm leading-relaxed">
            {m.contribution_loading({}, o)}
          </p>
        )}
        {state !== 'active' && (
          <p
            ref={failure ? undefined : resultFocus.boundaryRef}
            tabIndex={-1}
            role="status"
            className="font-medium leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {state === 'deleted'
              ? m.contribution_deleted({}, o)
              : state === 'expired'
                ? m.contribution_expired({}, o)
                : m.contribution_restored({}, o)}
          </p>
        )}
        {current && (
          <div data-content-item-slot="state" className="grid min-w-0 gap-4 sm:grid-cols-2">
            <ContentItemHeading level={3} className="min-w-0 text-sm font-medium leading-relaxed">
              {current.subject === 'available'
                ? m.contribution_subject_available({}, o)
                : m.contribution_read_unavailable({}, o)}
            </ContentItemHeading>
            <ContentItemHeading level={3} className="min-w-0 text-sm font-medium leading-relaxed">
              {current.candidate === 'deleted'
                ? m.contribution_tombstone({}, o)
                : current.candidate === 'available'
                  ? m.contribution_candidate_available({}, o)
                  : m.contribution_candidate_unconfirmed({}, o)}
            </ContentItemHeading>
            {state === 'restored' && current.selected === false && (
              <ContentItemHeading level={3} className="min-w-0 text-sm font-medium leading-relaxed sm:col-span-2">
                {m.contribution_unselected({}, o)}
              </ContentItemHeading>
            )}
          </div>
        )}
        <div data-content-item-slot="actions" className="flex min-w-0 flex-col gap-3">
          {state === 'deleted' && (
            <p className="text-sm leading-relaxed text-muted-foreground">{m.contribution_window({}, o)}</p>
          )}
          {failure && (
            <p
              ref={resultFocus.boundaryRef}
              tabIndex={-1}
              role="alert"
              className="text-sm font-medium leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
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
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
            {operation && state !== 'expired' && failure !== 'denied' && (
              <Button
                type="button"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2.5 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                variant={operation === 'delete' ? 'destructive' : 'default'}
                data-contribution-action={pending.current ? 'retry' : operation}
                disabled={busy}
                onClick={(event) => {
                  const expectedOperation = operation;
                  const retryCommand = pending.current;
                  if (!lifetime.active() || running.current || !expectedOperation || terminal.current) return;
                  if (retryCommand) {
                    if (pending.current === retryCommand) void change(event, { kind: 'retry', command: retryCommand });
                  } else if (controls.current.operation === expectedOperation) {
                    resultFocus.cancel();
                    resultFocus.suppressCloseFocus.current = false;
                    const admitted = { operation: expectedOperation };
                    controls.current.confirmation = admitted;
                    setConfirmation(admitted);
                  }
                }}
              >
                {pending.current ? m.contribution_retry({}, o) : action}
              </Button>
            )}
            {current && !pending.current && (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2.5 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {m.contribution_refresh({}, o)}
              </Button>
            )}
          </div>
        </div>
        <AlertDialog
          open={confirmation !== null}
          onOpenChange={(open) => lifetime.active() && !open && clearConfirmation(confirmation ?? undefined)}
        >
          <AlertDialogContent
            initialFocus={() => lifetime.active()}
            finalFocus={() => lifetime.active() && !resultFocus.suppressCloseFocus.current}
          >
            <AlertDialogHeader className="min-w-0 justify-items-stretch text-start sm:text-start">
              <AlertDialogTitle className="min-w-0 [overflow-wrap:anywhere]">{action}</AlertDialogTitle>
              <AlertDialogDescription className="min-w-0 [overflow-wrap:anywhere]">
                {confirmation?.operation === 'delete'
                  ? m.contribution_confirm_delete({}, o)
                  : m.contribution_confirm_restore({}, o)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="min-w-0 sm:flex-wrap">
              <AlertDialogCancel className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2.5 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.candidate_cancel({}, o)}
              </AlertDialogCancel>
              <AlertDialogAction
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2.5 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                variant={confirmation?.operation === 'delete' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={(event) => confirmation && void change(event, { kind: 'confirm', confirmation })}
              >
                {m.contribution_confirm({}, o)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ContentItemFrame>
    </section>
  );
}
