import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { m } from '../paraglide/messages.js';
import { useSettingsDisposal, useSettingsSessionOwner } from './settings-session-owner';
import { useSettingsNavigationDraft } from './reading-navigation';
import { usePreferenceRetry } from './preference-failure-retry';
import { WatchController } from './watch-controller';
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

/** Visited Settings panels keep this controller and its unresolved command alive across category changes. */
export function WatchesSection({ io = nativeWatchManagement }: { io?: WatchManagementIO | undefined }) {
  const owner = useSettingsSessionOwner(undefined);
  const [controller] = useState(() =>
    owner
      ? new WatchController(io, {
          subject: owner.subject ?? '',
          readCurrent: owner.readCurrent,
          credential: owner.credential,
          subscribe: owner.subscribe,
        })
      : null,
  );
  if (!controller || !owner) return null;
  return <OwnedWatches controller={controller} />;
}

function OwnedWatches({ controller }: { controller: WatchController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useLayoutEffect(controller.mount, [controller]);
  useSettingsDisposal(controller.retire);
  useSettingsNavigationDraft('watches', state.command !== null, controller.needsDecision, controller);
  useEffect(() => {
    if (controller.snapshot().read === 'idle') void controller.first();
  }, [controller]);
  const readWaiting = usePreferenceRetry(undefined, state.readRetryAt);
  const originalWaiting = usePreferenceRetry(undefined, state.writeRetryAt);
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
            <h2 id="settings-watches-heading">{m.settings_watches_heading()}</h2>
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
          {state.write === 'sending' ? <p role="status">{m.settings_watches_stopping()}</p> : null}
          {state.write === 'removed' ? <p role="status">{m.settings_watches_removed()}</p> : null}
          {state.write === 'rejected' || state.write === 'conflict' || state.write === 'denied' ? (
            <Alert variant="destructive">
              <AlertDescription
                data-response-status={state.problem?.status ?? ''}
                data-response-code={state.problem?.code ?? ''}
                data-retry-after={state.problem?.retryAfter}
              >
                {writeText}
              </AlertDescription>
            </Alert>
          ) : null}
          {state.write === 'uncertain' ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_watches_uncertain_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{m.settings_watches_uncertain_text()}</p>
                {originalWaiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
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
                  data-response-status={state.problem?.status ?? ''}
                  data-response-code={state.problem?.code ?? ''}
                  data-retry-after={state.problem?.retryAfter}
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
                          <a
                            href={row.target.href}
                            className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                          >
                            {row.target.title}
                          </a>
                        ) : (
                          <>
                            <p className="font-medium">{m.settings_watches_target_unavailable()}</p>
                            <p className="text-sm text-muted-foreground">{m.settings_watches_access_lost()}</p>
                          </>
                        )}
                      </div>
                      <Button
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
