import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { m } from '../paraglide/messages.js';
import { useSettingsDisposal, useSettingsSessionOwner } from './settings-session-owner';
import { useSettingsNavigationDraft } from './reading-navigation';
import { WatchController } from './watch-controller';
import { unavailableWatchManagement, type WatchManagementIO } from './watch-native';

const controlClass = 'h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5';

/** Visited Settings panels keep this controller and its unresolved command alive across category changes. */
export function WatchesSection({ io = unavailableWatchManagement }: { io?: WatchManagementIO | undefined }) {
  const owner = useSettingsSessionOwner(undefined);
  const [controller] = useState(() => owner ? new WatchController(io, owner) : null);
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
  if (state.retired) return null;
  const reading = state.read === 'idle' || state.read === 'loading';
  const failed = state.read === 'failed' || state.read === 'unavailable';
  const disabled = !!state.command || !controller.canWrite();
  return (
    <section id="watches" aria-labelledby="settings-watches-heading" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle><h2 id="settings-watches-heading">{m.settings_watches_heading()}</h2></CardTitle>
          <CardDescription>{m.settings_watches_text()}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-5">
          {state.write === 'sending' ? <p role="status">{m.settings_watches_stopping()}</p> : null}
          {state.write === 'removed' ? <p role="status">{m.settings_watches_removed()}</p> : null}
          {state.write === 'rejected' ? (
            <Alert variant="destructive"><AlertDescription>{m.settings_watches_rejected()}</AlertDescription></Alert>
          ) : null}
          {state.write === 'uncertain' ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_watches_uncertain_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{m.settings_watches_uncertain_text()}</p>
                <Button className={controlClass} variant="outline" disabled={!controller.canWrite() || reading}
                  onClick={() => void controller.retryOriginal()}>{m.settings_watches_retry_original()}</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {reading ? <p role="status" aria-busy="true">{m.settings_watches_loading()}</p> : null}
          {failed ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_watches_failed_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{state.read === 'unavailable' ? m.settings_watches_unavailable() : m.settings_watches_failed_text()}</p>
                <Button className={controlClass} variant="outline" onClick={() => void controller.refresh()}>
                  {m.settings_retry()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {state.read === 'ready' ? (
            <>
              {state.rows.length === 0 ? (
                <p role="status">{state.next !== null ? m.settings_watches_sparse() :
                  state.cursor === null ? m.settings_watches_empty() : m.settings_watches_end()}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {state.rows.map((row) => (
                    <li key={row.subscriptionId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4">
                      <div className="min-w-0 flex-1 basis-48 space-y-1 break-words">
                        <p className="text-xs text-muted-foreground">
                          {row.kind === 'thread' ? m.settings_watches_thread() : m.settings_watches_board()}
                        </p>
                        {row.target ? (
                          <a href={row.target.href} className="inline-flex min-h-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                            {row.target.title}
                          </a>
                        ) : (
                          <>
                            <p className="font-medium">{m.settings_watches_target_unavailable()}</p>
                            <p className="text-sm text-muted-foreground">{m.settings_watches_access_lost()}</p>
                          </>
                        )}
                      </div>
                      <Button className={controlClass} variant="outline" disabled={disabled}
                        onClick={() => void controller.stop(row.subscriptionId)}>{m.settings_watches_stop()}</Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-3">
                <Button className={controlClass} variant="outline" onClick={() => void controller.refresh()}>
                  {m.settings_watches_refresh()}
                </Button>
                {state.next !== null ? (
                  <Button className={controlClass} variant="outline" onClick={() => void controller.next()}>
                    {m.settings_watches_next()}
                  </Button>
                ) : null}
                {state.cursor !== null ? (
                  <Button className={controlClass} variant="outline" onClick={() => void controller.first()}>
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
