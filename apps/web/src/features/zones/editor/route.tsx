import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { useSession } from '../../../session/query';
import {
  captureOwnerRead,
  hasValidOwnerCsrfToken,
  sameOwnerRead,
  useOwnerLifetime,
  type OwnerCapture,
  type OwnerReadObservation,
} from './owner-lifetime';
import { ZoneEditorSession, type Failure, type Loaded, type Mutation } from './model';
import { readConfiguration, readMountChoices, readSavedPreview, writeConfiguration } from './server';
import { EditorFailure, EditorLoading, ZoneConfigurationEditor } from './view';

const missingAdmission: Failure = { kind: 'failure', status: 401, code: 'unauthorized' };
function missingAdmissionData(): Loaded {
  return {
    resource: missingAdmission,
    permissions: { configure: false, publish: false, available: false },
    options: { scopes: missingAdmission, collections: missingAdmission },
  };
}

export function ZoneEditorRoute({
  id,
  locale,
  initial,
  requestedOwner,
  readMatchesRoute = true,
}: {
  id: string;
  locale: string;
  initial: Loaded;
  requestedOwner: OwnerReadObservation | null;
  readMatchesRoute?: boolean;
}) {
  const router = useRouter();
  const { state: sessionState } = useSession();
  const location = useLocation();
  const route = `${id}:${locale}:${location.pathname}:${JSON.stringify(location.search ?? {})}`;
  const { lifetime, snapshot } = useOwnerLifetime(route, requestedOwner);
  const capture = snapshot.capture;
  const invalidated = useRef<string | null>(null);
  const invalidationKey = `${route}:${snapshot.incarnation}:${requestedOwner?.admission ?? 'none'}`;
  const requestedCurrent = sameOwnerRead(requestedOwner, capture?.observation);
  const admitted = readMatchesRoute && requestedCurrent && lifetime.owns(initial.ownerObservation);

  useLayoutEffect(() => {
    if (!capture || !lifetime.isCurrent(capture)) return;
    if (!readMatchesRoute) {
      lifetime.retire(capture);
      return;
    }
    if (requestedCurrent && !admitted) lifetime.retire(capture);
  }, [admitted, capture, lifetime, readMatchesRoute, requestedCurrent]);
  useEffect(() => {
    if (!capture || !readMatchesRoute || requestedCurrent || admitted || !lifetime.isCurrent(capture)) return;
    if (invalidated.current === invalidationKey) return;
    invalidated.current = invalidationKey;
    void router.invalidate();
  }, [admitted, capture, invalidationKey, lifetime, readMatchesRoute, requestedCurrent, router]);

  if (!capture || !admitted) {
    const refusedFailure =
      capture && requestedCurrent && initial.resource.kind === 'failure' && !initial.ownerObservation
        ? initial.resource
        : undefined;
    return (
      <section className="space-y-3" aria-label={m.zone_editor_heading()}>
        {sessionState === 'signed-out' ? (
          <>
            <EditorFailure failure={{ kind: 'failure', status: 401, code: 'unauthorized' }} />
            <a
              className="underline"
              href={`/auth/sign-in?return_to=${encodeURIComponent(location.pathname + location.search)}`}
            >
              {m.zones_owner_sign_in({}, { locale: locale as never })}
            </a>
          </>
        ) : refusedFailure ? (
          <EditorFailure failure={refusedFailure} />
        ) : (
          <EditorLoading />
        )}
        <Button
          onClick={() => {
            if (lifetime.isCurrent(capture)) void router.invalidate();
          }}
        >
          {m.zone_editor_retry()}
        </Button>
      </section>
    );
  }

  return (
    <AdmittedZoneEditor
      key={`${route}:${snapshot.incarnation}`}
      id={id}
      locale={locale}
      initial={initial}
      capture={capture}
      lifetime={lifetime}
    />
  );
}

function AdmittedZoneEditor({
  id,
  locale,
  initial,
  capture,
  lifetime,
}: {
  id: string;
  locale: string;
  initial: Loaded;
  capture: OwnerCapture;
  lifetime: ReturnType<typeof useOwnerLifetime>['lifetime'];
}) {
  const [session] = useState(() => {
    const reader = capture.observation;
    const transport = {
      load: () =>
        readConfiguration({ data: { id, locale, expectedReader: reader.reader, admission: reader.admission } }),
      mutate: (data: Mutation) =>
        writeConfiguration({
          data: { ...data, locale, expectedReader: reader.reader, admission: reader.admission },
          headers: { 'X-CSRF-Token': capture.csrfToken ?? '' },
        }),
      preview: (route: string) =>
        readSavedPreview({ data: { id, locale, route, expectedReader: reader.reader, admission: reader.admission } }),
      collections: (cursor: string) =>
        readMountChoices({ data: { locale, cursor, expectedReader: reader.reader, admission: reader.admission } }),
    };
    return new ZoneEditorSession(transport, initial, undefined, {
      isCurrent: () => lifetime.isCurrent(capture),
      observation: reader,
      retire: () => lifetime.retire(capture),
      canWrite: () => lifetime.isCurrent(capture) && hasValidOwnerCsrfToken(capture.csrfToken),
    });
  });
  if (!session.isCurrent()) return <EditorLoading />;
  return (
    <ZoneConfigurationEditor
      session={session}
      locale={locale}
      enabled
      writeEnabled={hasValidOwnerCsrfToken(capture.csrfToken)}
    />
  );
}

export async function loadZoneEditor(
  id: string,
  locale: string,
  queryClient: Parameters<typeof captureOwnerRead>[0],
  search: unknown = {},
  signal?: AbortSignal,
) {
  const requestedOwner = captureOwnerRead(queryClient, signal);
  const initial = requestedOwner
    ? await readConfiguration({
        data: { id, locale, expectedReader: requestedOwner.reader, admission: requestedOwner.admission },
      })
    : missingAdmissionData();
  return { initial, requestedOwner, loadedFor: { id, locale, search: JSON.stringify(search ?? {}) } };
}
