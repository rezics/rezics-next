import { useState, useSyncExternalStore } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { useSession } from '../../../session/query';
import { m } from '../../../paraglide/messages.js';
import { ZoneEditorSession, type Loaded } from './model';
import { readConfiguration, readMountChoices, readSavedPreview, writeConfiguration } from './server';
import { ZoneConfigurationEditor } from './view';

export function ZoneEditorRoute({ id, locale, initial }: { id: string; locale: string; initial: Loaded }) {
  const { csrfToken, state: sessionState } = useSession();
  const [session] = useState(
    () =>
      new ZoneEditorSession(
        {
          load: () => readConfiguration({ data: { id, locale } }),
          mutate: (data) =>
            writeConfiguration({ data: { ...data, locale }, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
          preview: (route) => readSavedPreview({ data: { id, locale, route } }),
          collections: (cursor) => readMountChoices({ data: { locale, cursor } }),
        },
        initial,
      ),
  );
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  // The session query hydrates after this component mounts; use the current token for every write.
  session.setTransport({
    load: () => readConfiguration({ data: { id, locale } }),
    mutate: (data) => writeConfiguration({ data: { ...data, locale }, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
    preview: (route) => readSavedPreview({ data: { id, locale, route } }),
    collections: (cursor) => readMountChoices({ data: { locale, cursor } }),
  });
  const blocker = useBlocker({ shouldBlockFn: () => session.dirty(), withResolver: true });
  return (
    <>
      {blocker.status === 'blocked' ? (
        <section role="alert" className="mb-6 space-y-3 rounded-xl border border-border p-4">
          <p>{m.zone_editor_leave()}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => blocker.reset()}>{m.zone_editor_stay()}</Button>
            <Button variant="outline" onClick={() => blocker.proceed()}>
              {m.zone_editor_discard()}
            </Button>
          </div>
        </section>
      ) : null}
      <ZoneConfigurationEditor
        session={session}
        locale={locale}
        enabled={sessionState === 'signed-in' && !!csrfToken}
      />
    </>
  );
}
