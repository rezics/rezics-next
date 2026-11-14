import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { m } from '../paraglide/messages.js';
import { useSettingsDisposal, useSettingsSessionOwner } from './settings-session-owner';
import { useSettingsNavigationDraft } from './reading-navigation';
import { usePreferenceRetry } from './preferences';
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import { WatchController, type WatchReturnReceipt } from './watch-controller';
import { readWatchInventory, removeWatchSubscription } from './actions';
import type { WatchManagementIO } from './watch-native';

const controlClass = 'h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5';

type BoardPlace = Readonly<{ realmId: string; title: string }> | null;

/** A missing place field is an older client shape, not evidence that a Board is Global. */
function admittedBoardPlace(target: { title: string; href: string } | null): BoardPlace | undefined {
  if (!target || !('place' in target)) return undefined;
  const place = target.place;
  if (place === null) return null;
  if (
    !place ||
    typeof place !== 'object' ||
    !('realmId' in place) ||
    typeof place.realmId !== 'string' ||
    !('title' in place) ||
    typeof place.title !== 'string'
  )
    return undefined;
  return { realmId: place.realmId, title: place.title };
}

function boardPlaceLabel(place: BoardPlace) {
  return place === null ? m.board_directory_global() : m.game_visit_realm({ realm: place.title });
}

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

function createController(
  io: WatchManagementIO,
  owner: NonNullable<ReturnType<typeof useSettingsSessionOwner>>,
  ambient: ReturnType<typeof useSettingsAmbient>,
) {
  return new WatchController(
    io,
    {
      subject: owner.subject ?? '',
      readCurrent: owner.readCurrent,
      credential: owner.credential,
      subscribe: owner.subscribe,
    },
    ambient,
    owner,
  );
}

/** Visited Settings panels keep this controller and its unresolved command alive across category changes. */
export function WatchesSection({
  io = nativeWatchManagement,
  initialReturn = null,
  onVisitTarget,
}: WatchesSectionProps) {
  const ambient = useSettingsAmbient();
  const owner = useSettingsSessionOwner(undefined);
  const [entry, setEntry] = useState(() => ({
    io,
    owner,
    controller: owner ? createController(io, owner, ambient) : null,
  }));
  if (!owner) return null;
  if (entry.io !== io || entry.owner !== owner) {
    setEntry({ io, owner, controller: createController(io, owner, ambient) });
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
  const pendingStatus = useRef<HTMLParagraphElement>(null);
  const returnStop = useRef<HTMLButtonElement>(null);
  const retryOriginal = useRef<HTMLButtonElement>(null);
  const stopButtons = useRef(new Map<string, HTMLButtonElement>());
  const boardConfirmation = useRef<{ title: string; place: BoardPlace } | null>(null);
  const focusMovement = useRef(0);
  const returnMovement = useRef(0);
  const ignoredFocus = useRef<EventTarget | null>(null);
  const continuation = useRef<
    | { kind: 'window'; movement: number }
    | { kind: 'stop'; movement: number; subscriptionId: string; index: number }
    | null
  >(null);
  useLayoutEffect(controller.mount, [controller]);
  useSettingsDisposal(controller.retire);
  useSettingsNavigationDraft('watches', state.command !== null, controller.needsDecision, controller);
  useEffect(() => {
    const moved = (event: FocusEvent) => {
      if (event.target === ignoredFocus.current) {
        ignoredFocus.current = null;
        return;
      }
      focusMovement.current++;
    };
    document.addEventListener('focusin', moved, true);
    return () => document.removeEventListener('focusin', moved, true);
  }, []);
  useEffect(() => {
    if (controller.snapshot().read !== 'idle') return;
    if (initialReturn) {
      returnMovement.current = focusMovement.current;
      void controller.returnTo(initialReturn);
    } else void controller.first();
  }, [controller, initialReturn]);
  useEffect(() => {
    if (state.read !== 'ready') boardConfirmation.current = null;
  }, [state.read]);
  useLayoutEffect(() => {
    const receipt = state.returnFocus;
    if (!receipt) return;
    if (receipt.focusRequested && focusMovement.current === returnMovement.current && !controller.snapshot().retired) {
      if (receipt.outcome === 'restored' && returnStop.current && !returnStop.current.disabled)
        returnStop.current.focus();
      else heading.current?.focus();
    }
    controller.finishReturnFocus();
  }, [controller, state.returnFocus]);
  const focusRow = (index: number, preferredId?: string) => {
    const current = controller.snapshot();
    if (current.retired) return;
    const rows = current.rows;
    const preferred = preferredId ? rows.find((row) => row.subscriptionId === preferredId) : undefined;
    const row = preferred ?? rows[Math.min(index, rows.length - 1)];
    const button = row ? stopButtons.current.get(row.subscriptionId) : undefined;
    if (button && !button.disabled) button.focus();
    else heading.current?.focus();
  };
  const focusHeading = () => {
    if (!controller.snapshot().retired) heading.current?.focus();
  };
  const focusPendingStatus = () => {
    const target = pendingStatus.current;
    if (!target) return;
    ignoredFocus.current = target;
    target.focus();
    if (ignoredFocus.current === target) ignoredFocus.current = null;
  };
  const rememberWindowFocus = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0 && document.activeElement === event.currentTarget)
      continuation.current = { kind: 'window', movement: focusMovement.current };
  };
  const rememberStopFocus = (event: MouseEvent<HTMLButtonElement>, subscriptionId: string) => {
    if (event.detail !== 0 || document.activeElement !== event.currentTarget) return;
    const rows = controller.snapshot().rows;
    continuation.current = {
      kind: 'stop',
      movement: focusMovement.current,
      subscriptionId,
      index: Math.max(
        0,
        rows.findIndex((row) => row.subscriptionId === subscriptionId),
      ),
    };
  };
  useLayoutEffect(() => {
    const pending = continuation.current;
    if (!pending) return;
    if (state.retired || pending.movement !== focusMovement.current) {
      continuation.current = null;
      return;
    }
    if (pending.kind === 'window') {
      if (state.read === 'loading') {
        focusPendingStatus();
        return;
      }
      if (state.read === 'idle') return;
      continuation.current = null;
      if (state.read === 'ready') focusRow(0);
      else focusHeading();
      return;
    }
    if (state.write === 'sending') {
      focusPendingStatus();
      return;
    }
    continuation.current = null;
    if (state.write === 'uncertain') {
      if (controller.canRetryOriginal()) retryOriginal.current?.focus();
      else focusHeading();
    } else if (state.write === 'removed_current') {
      focusRow(pending.index, pending.subscriptionId);
    } else if (state.write === 'removed') {
      focusRow(pending.index);
    } else if (state.rows.some((row) => row.subscriptionId === pending.subscriptionId)) {
      focusRow(pending.index, pending.subscriptionId);
    } else focusHeading();
  }, [controller, focusHeading, focusPendingStatus, focusRow, state]);
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
  const confirmedBoard =
    state.read === 'ready' && state.kind === 'board' &&
    (state.write === 'removed' || state.write === 'removed_current')
      ? boardConfirmation.current
      : null;
  return (
    <section id="watches" aria-labelledby="settings-watches-heading" className="scroll-mt-6">
      <ContentSection>
        <ContentSectionHeader>
          <ContentSectionTitle>
            <h2
              ref={heading}
              id="settings-watches-heading"
              tabIndex={-1}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.settings_watches_heading()}
            </h2>
          </ContentSectionTitle>
          <ContentSectionDescription>{m.settings_watches_text()}</ContentSectionDescription>
        </ContentSectionHeader>
        <ContentSectionBody className="min-w-0 space-y-5">
          <div role="group" aria-label={m.settings_watches_heading()} className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              className={controlClass}
              variant="outline"
              aria-pressed={state.kind === 'thread'}
              disabled={readWaiting || state.read === 'loading' || state.command !== null || state.write === 'sending'}
              onClick={(event) => {
                if (state.kind !== 'thread') rememberWindowFocus(event);
                void controller.selectKind('thread');
              }}
            >
              {m.settings_watches_thread()}
            </Button>
            <Button
              type="button"
              className={controlClass}
              variant="outline"
              aria-pressed={state.kind === 'board'}
              disabled={readWaiting || state.read === 'loading' || state.command !== null || state.write === 'sending'}
              onClick={(event) => {
                if (state.kind !== 'board') rememberWindowFocus(event);
                void controller.selectKind('board');
              }}
            >
              {m.settings_watches_board()}
            </Button>
          </div>
          {state.returnOutcome === 'restored' ? (
            <p role="status">{m.settings_watches_returned()}</p>
          ) : state.returnOutcome ? (
            <p role="status">{m.settings_watches_return_missing()}</p>
          ) : null}
          {state.write === 'sending' ? (
            <p
              ref={pendingStatus}
              role="status"
              tabIndex={-1}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {m.settings_watches_stopping()}
            </p>
          ) : null}
          {state.write === 'removed' || state.write === 'removed_current' ? (
            <p role="status">
              {state.write === 'removed' ? m.settings_watches_removed() : m.settings_watches_removed_current()}
              {confirmedBoard ? (
                <span className="block font-medium">
                  {confirmedBoard.title}
                  <span className="block text-sm text-muted-foreground">{boardPlaceLabel(confirmedBoard.place)}</span>
                </span>
              ) : null}
            </p>
          ) : null}
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
                  ref={retryOriginal}
                  className={controlClass}
                  variant="outline"
                  disabled={!controller.canRetryOriginal()}
                  onClick={(event) => {
                    const command = state.command;
                    if (command) {
                      rememberStopFocus(event, command.watchId);
                      const row = state.rows.find(
                        (candidate) =>
                          candidate.subscriptionId === command.watchId &&
                          candidate.kind === command.kind &&
                          candidate.revision === command.expectedRevision,
                      );
                      const place = row?.kind === 'board' ? admittedBoardPlace(row.target) : undefined;
                      boardConfirmation.current =
                        row?.target && place !== undefined ? { title: row.target.title, place } : null;
                    }
                    void controller.retryOriginal();
                  }}
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
            <p
              ref={pendingStatus}
              role="status"
              aria-busy="true"
              tabIndex={-1}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
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
                    onClick={(event) => {
                      rememberWindowFocus(event);
                      void controller.first();
                    }}
                  >
                    {m.settings_watches_restart()}
                  </Button>
                ) : (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={(event) => {
                      rememberWindowFocus(event);
                      void controller.refresh();
                    }}
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
                  {state.rows.map((row) => {
                    const target = row.target;
                    const place = row.kind === 'board' ? admittedBoardPlace(target) : undefined;
                    const placeLabel = place === undefined ? null : boardPlaceLabel(place);
                    const titleId = `watch-title-${row.subscriptionId}`;
                    const placeId = `watch-place-${row.subscriptionId}`;
                    const stopLabelId = `watch-stop-${row.subscriptionId}`;
                    return (
                      <li
                        key={row.subscriptionId}
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4"
                      >
                        <div className="min-w-0 flex-1 basis-48 space-y-1 break-words">
                          <p className="text-xs text-muted-foreground">
                            {row.kind === 'thread' ? m.settings_watches_thread() : m.settings_watches_board()}
                          </p>
                          {target ? (
                            <div className="space-y-1">
                              {onVisitTarget ? (
                                <Link
                                  to={target.href as never}
                                  aria-labelledby={placeLabel === null ? undefined : `${titleId} ${placeId}`}
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
                                    if (receipt && !onVisitTarget(receipt, target.href)) event.preventDefault();
                                  }}
                                  className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                                >
                                  <span id={titleId}>{target.title}</span>
                                </Link>
                              ) : (
                                <a
                                  href={target.href}
                                  aria-labelledby={placeLabel === null ? undefined : `${titleId} ${placeId}`}
                                  className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                                >
                                  <span id={titleId}>{target.title}</span>
                                </a>
                              )}
                              {placeLabel !== null ? (
                                <p id={placeId} className="text-sm text-muted-foreground">{placeLabel}</p>
                              ) : null}
                            </div>
                          ) : (
                            <>
                              <p className="font-medium">{m.settings_watches_target_unavailable()}</p>
                              <p className="text-sm text-muted-foreground">{m.settings_watches_access_lost()}</p>
                            </>
                          )}
                        </div>
                        <Button
                          ref={(button) => {
                            if (button) stopButtons.current.set(row.subscriptionId, button);
                            else stopButtons.current.delete(row.subscriptionId);
                            if (
                              state.returnFocus?.outcome === 'restored' &&
                              state.returnFocus.identity.subscriptionId === row.subscriptionId &&
                              state.returnFocus.identity.kind === row.kind &&
                              state.returnFocus.identity.revision === row.revision
                            )
                              returnStop.current = button;
                          }}
                          className={controlClass}
                          variant="outline"
                          aria-labelledby={target && placeLabel !== null ? `${stopLabelId} ${titleId} ${placeId}` : undefined}
                          disabled={disabled}
                          onClick={(event) => {
                            rememberStopFocus(event, row.subscriptionId);
                            const stopping = controller.stop(row.subscriptionId);
                            const command = controller.snapshot().command;
                            boardConfirmation.current =
                              command?.watchId === row.subscriptionId &&
                              command.kind === 'board' &&
                              command.expectedRevision === row.revision &&
                              target &&
                              place !== undefined
                                ? { title: target.title, place }
                                : null;
                            void stopping;
                          }}
                        >
                          <span id={stopLabelId}>{m.settings_watches_stop()}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  className={controlClass}
                  variant="outline"
                  disabled={readWaiting}
                  onClick={(event) => {
                    rememberWindowFocus(event);
                    void controller.refresh();
                  }}
                >
                  {m.settings_watches_refresh()}
                </Button>
                {state.previous.length > 0 ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={(event) => {
                      rememberWindowFocus(event);
                      void controller.previous();
                    }}
                  >
                    {m.settings_watches_previous()}
                  </Button>
                ) : null}
                {state.next !== null ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={(event) => {
                      rememberWindowFocus(event);
                      void controller.next();
                    }}
                  >
                    {m.settings_watches_next()}
                  </Button>
                ) : null}
                {state.cursor !== null ? (
                  <Button
                    className={controlClass}
                    variant="outline"
                    disabled={readWaiting}
                    onClick={(event) => {
                      rememberWindowFocus(event);
                      void controller.first();
                    }}
                  >
                    {m.settings_watches_first()}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </ContentSectionBody>
      </ContentSection>
    </section>
  );
}
