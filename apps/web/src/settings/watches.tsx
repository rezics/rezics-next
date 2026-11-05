import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { m } from '../paraglide/messages.js';
import { useSettingsDisposal, useSettingsSessionOwner } from './settings-session-owner';
import { useSettingsNavigationDraft } from './reading-navigation';
import { usePreferenceRetry } from './preference-failure-retry';
import { WatchController, type WatchReturnReceipt } from './watch-controller';
import { readWatchInventory, removeWatchSubscription } from './actions';
import type { WatchManagementIO } from './watch-native';

const controlClass = 'h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5';

const nativeWatchManagement: WatchManagementIO = {
  read: ({ accountId, kind, limit, cursor, signal }) =>
    readWatchInventory({ data: { accountId, kind, limit, cursor }, signal }),
  stop: (input, csrfToken) =>
    removeWatchSubscription({
      data: { ...input, csrfToken },
      headers: { 'X-CSRF-Token': csrfToken },
    }),
};

type WatchesSectionProps = {
  io?: WatchManagementIO | undefined;
  initialReturn?: WatchReturnReceipt | null;
  onVisitTarget?: (receipt: WatchReturnReceipt, href: string) => boolean;
};

function createController(io: WatchManagementIO, owner: NonNullable<ReturnType<typeof useSettingsSessionOwner>>) {
  return new WatchController(io, {
    subject: owner.subject ?? '',
    readCurrent: owner.readCurrent,
    credential: owner.credential,
    subscribe: owner.subscribe,
  }, owner);
}

/** Visited Settings panels keep this controller and its unresolved command alive across category changes. */
export function WatchesSection({
  io = nativeWatchManagement,
  initialReturn = null,
  onVisitTarget,
}: WatchesSectionProps) {
  const owner = useSettingsSessionOwner(undefined);
  const [entry, setEntry] = useState(() => ({ io, owner, controller: owner ? createController(io, owner) : null }));
  if (!owner) return null;
  if (entry.io !== io || entry.owner !== owner) {
    setEntry({ io, owner, controller: createController(io, owner) });
    return null;
  }
  if (!entry.controller) return null;
  return <OwnedWatches controller={entry.controller} initialReturn={initialReturn} onVisitTarget={onVisitTarget} />;
}

function OwnedWatches({
  controller,
  initialReturn,
  onVisitTarget,
}: {
  controller: WatchController;
  initialReturn: WatchReturnReceipt | null;
  onVisitTarget?: WatchesSectionProps['onVisitTarget'];
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnStop = useRef<HTMLButtonElement>(null);
  const focusMovement = useRef(0);
  useLayoutEffect(controller.mount, [controller]);
  useSettingsDisposal(controller.retire);
  useSettingsNavigationDraft('watches', state.command !== null, controller.needsDecision, controller);
  useEffect(() => {
    const moved = () => {
      focusMovement.current++;
    };
    document.addEventListener('focusin', moved, true);
    return () => document.removeEventListener('focusin', moved, true);
  }, []);
  useEffect(() => {
    if (controller.snapshot().read !== 'idle') return;
    if (initialReturn) void controller.returnTo(initialReturn);
    else void controller.first();
  }, [controller, initialReturn]);
  useLayoutEffect(() => {
    const receipt = state.returnFocus;
    if (!receipt) return;
    if (receipt.focusRequested && focusMovement.current === 0) {
      if (receipt.outcome === 'restored') returnStop.current?.focus();
      else heading.current?.focus();
    }
    controller.finishReturnFocus();
  }, [controller, state.returnFocus]);
  const readWaiting = usePreferenceRetry(undefined, state.readRetryAt);
  const writeWaiting = usePreferenceRetry(undefined, state.writeRetryAt);
  if (state.retired) return null;
  const reading = state.read === 'idle' || state.read === 'loading';
  const failed =
    state.read === 'failed' ||
    state.read === 'unavailable' ||
    state.read === 'denied' ||
    state.read === 'invalid_cursor';
  const disabled = !!state.command || !controller.canRemove();
  const readText =
    state.read === 'denied'
      ? m.settings_watches_denied()
      : state.read === 'invalid_cursor'
        ? m.settings_watches_invalid_cursor()
        : state.read === 'unavailable'
          ? m.settings_watches_unavailable()
          : m.settings_watches_failed_text();
  const writeText =
    state.write === 'denied'
      ? m.settings_watches_remove_denied()
      : state.write === 'conflict'
        ? m.settings_watches_conflict()
        : m.settings_watches_rejected();
  return (
    <section id="watches" aria-labelledby="settings-watches-heading" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2
              ref={heading}
              id="settings-watches-heading"
              tabIndex={-1}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.settings_watches_heading()}
            </h2>
          </CardTitle>
          <CardDescription>{m.settings_watches_text()}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-5">
          <div role="group" aria-label={m.settings_watches_heading()} className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              className={controlClass}
              variant="outline"
              aria-pressed={state.kind === 'thread'}
              disabled={readWaiting || state.read === 'loading' || state.command !== null || state.write === 'sending'}
              onClick={() => void controller.selectKind('thread')}
            >
              {m.settings_watches_thread()}
            </Button>
            <Button
              type="button"
              className={controlClass}
              variant="outline"
              aria-pressed={state.kind === 'board'}
              disabled={readWaiting || state.read === 'loading' || state.command !== null || state.write === 'sending'}
              onClick={() => void controller.selectKind('board')}
            >
              {m.settings_watches_board()}
            </Button>
          </div>
          {state.returnOutcome === 'restored' ? (
            <p role="status">{m.settings_watches_returned()}</p>
          ) : state.returnOutcome ? (
            <p role="status">{m.settings_watches_return_missing()}</p>
          ) : null}
          {state.write === 'sending' ? <p role="status">{m.settings_watches_stopping()}</p> : null}
          {state.write === 'removed' ? <p role="status">{m.settings_watches_removed()}</p> : null}
          {state.write === 'removed_current' ? <p role="status">{m.settings_watches_removed_current()}</p> : null}
          {state.write === 'rejected' || state.write === 'conflict' || state.write === 'denied' ? (
            <Alert variant="destructive">
              <AlertDescription className="space-y-3">
                <p
                  data-response-status={state.writeProblem?.status ?? ''}
                  data-response-code={state.writeProblem?.code ?? ''}
                  data-retry-after={state.writeProblem?.retryAfter}
                >
                  {writeText}
                </p>
                {writeWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {state.write === 'uncertain' ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_watches_uncertain_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p
                  data-response-status={state.writeProblem?.status ?? ''}
                  data-response-code={state.writeProblem?.code ?? ''}
                  data-retry-after={state.writeProblem?.retryAfter}
                >
                  {m.settings_watches_uncertain_text()}
                </p>
                {writeWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
                <Button
                  className={controlClass}
                  variant="outline"
                  disabled={!controller.canRetryOriginal()}
                  onClick={() => void controller.retryOriginal()}
                >
                  {m.settings_watches_retry_original()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {writeWaiting && !['uncertain', 'rejected', 'conflict', 'denied'].includes(state.write) ? (
            <p role="status">{m.settings_retry_wait()}</p>
          ) : null}
          {reading ? (
            <p role="status" aria-busy="true">
              {m.settings_watches_loading()}
            </p>
          ) : null}
          {failed ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_watches_failed_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p
                  data-response-status={state.readProblem?.status ?? ''}
                  data-response-code={state.readProblem?.code ?? ''}
                  data-retry-after={state.readProblem?.retryAfter}
                >
                  {readText}
                </p>
                {readWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
                {state.read === 'invalid_cursor' ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={() => void controller.first()}
                  >
                    {m.settings_watches_restart()}
                  </Button>
                ) : (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={() => void controller.refresh()}
                  >
                    {m.settings_retry()}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          {state.read === 'ready' && state.actions?.remove === 'denied' ? (
            <Alert>
              <AlertDescription>{m.settings_watches_remove_denied()}</AlertDescription>
            </Alert>
          ) : null}
          {state.read === 'ready' ? (
            <>
              {state.rows.length === 0 ? (
                <p role="status">
                  {state.next !== null
                    ? m.settings_watches_sparse()
                    : state.cursor === null
                      ? m.settings_watches_empty()
                      : m.settings_watches_end()}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {state.rows.map((row) => (
                    <li
                      key={row.subscriptionId}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4"
                    >
                      <div className="min-w-0 flex-1 basis-48 space-y-1 break-words">
                        <p className="text-xs text-muted-foreground">
                          {row.kind === 'thread' ? m.settings_watches_thread() : m.settings_watches_board()}
                        </p>
                        {row.target ? (
                          onVisitTarget ? (
                            <Link
                              to={row.target.href as never}
                              onClick={(event) => {
                                if (
                                  event.defaultPrevented ||
                                  event.button !== 0 ||
                                  event.metaKey ||
                                  event.ctrlKey ||
                                  event.altKey ||
                                  event.shiftKey ||
                                  (event.currentTarget.target && event.currentTarget.target !== '_self')
                                )
                                  return;
                                const receipt = controller.captureReturn(
                                  row.subscriptionId,
                                  event.detail === 0 && document.activeElement === event.currentTarget,
                                );
                                if (receipt && !onVisitTarget(receipt, row.target.href)) event.preventDefault();
                              }}
                              className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                              {row.target.title}
                            </Link>
                          ) : (
                            <a
                              href={row.target.href}
                              className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                            >
                              {row.target.title}
                            </a>
                          )
                        ) : (
                          <>
                            <p className="font-medium">{m.settings_watches_target_unavailable()}</p>
                            <p className="text-sm text-muted-foreground">{m.settings_watches_access_lost()}</p>
                          </>
                        )}
                      </div>
                      <Button
                        ref={
                          state.returnFocus?.outcome === 'restored' &&
                          state.returnFocus.identity.subscriptionId === row.subscriptionId &&
                          state.returnFocus.identity.kind === row.kind &&
                          state.returnFocus.identity.revision === row.revision
                            ? returnStop
                            : undefined
                        }
                        className={controlClass}
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void controller.stop(row.subscriptionId)}
                      >
                        {m.settings_watches_stop()}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  className={controlClass}
                  variant="outline"
                  disabled={readWaiting}
                  onClick={() => void controller.refresh()}
                >
                  {m.settings_watches_refresh()}
                </Button>
                {state.previous.length > 0 ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={() => void controller.previous()}
                  >
                    {m.settings_watches_previous()}
                  </Button>
                ) : null}
                {state.next !== null ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={() => void controller.next()}
                  >
                    {m.settings_watches_next()}
                  </Button>
                ) : null}
                {state.cursor !== null ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={() => void controller.first()}
                  >
                    {m.settings_watches_first()}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
