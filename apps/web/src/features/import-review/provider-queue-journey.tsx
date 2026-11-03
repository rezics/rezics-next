import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../session/query';
import {
  readProviderScopeAction,
  prepareProviderScopeAction,
  decideProviderScopeAction,
  readProviderScopeSubjectsAction,
  searchProviderContextsAction,
  resolveProviderContextAction,
} from './provider-queue-actions';
import { ProviderQueue } from './provider-queue-view';
import {
  peekProviderQueueReturn,
  saveProviderQueueReturn,
  takeProviderQueueReturn,
  type ProviderQueueReturnVisit,
  type QueueTransport,
} from './provider-queue';
import type { ProviderContextSource } from './provider-context-choice';
import {
  providerSessionSource,
  providerReaderMatches,
  useProviderVisit,
  type ProviderAdmission,
  type ProviderEnvelope,
} from './provider-visit';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** Injection retains actual session Query ownership in stories; production uses the same admission wrapper. */
export function ProviderQueueJourney({
  adapters,
}: {
  adapters?: (reader: ProviderAdmission) => { transport: QueueTransport; contexts: ProviderContextSource };
} = {}) {
  const client = useQueryClient();
  const session = useSession();
  const source = useMemo(() => providerSessionSource(client), [client]);
  const admission = useSyncExternalStore(source.subscribe, source.snapshot, () => null);
  const [restored, setRestored] = useState<{ admission: string; visit: ProviderQueueReturnVisit } | null>(null);
  useEffect(() => {
    if (restored && restored.admission !== admission?.id) setRestored(null);
    if (!admission) return;
    const visit = peekProviderQueueReturn(source, admission);
    if (visit) setRestored({ admission: admission.id, visit });
  }, [source, admission]);
  useEffect(() => {
    if (!admission || !restored || restored.admission !== admission.id) return;
    takeProviderQueueReturn(source, admission, restored.visit.id);
  }, [source, admission, restored]);
  const owner = useMemo(() => () => !!admission && source.current(admission), [source, admission]);
  const [refused, setRefused] = useState(false);
  const [recovery, setRecovery] = useState(0);
  const identity = useMemo(() => ({}), [adapters, recovery]);
  const visit = useProviderVisit(owner, identity);
  const bound = useMemo(() => {
    if (!admission) return null;
    const headers = {
      'X-Provider-Reader': admission.subject,
      ...(admission.csrfToken ? { 'X-Provider-Token': admission.csrfToken, 'X-CSRF-Token': admission.csrfToken } : {}),
    };
    async function admitted<T>(read: () => Promise<ProviderEnvelope<T>>): Promise<T> {
      visit.assert();
      const response = await read();
      visit.assert();
      if (!providerReaderMatches(response.reader, admission!)) {
        visit.retire();
        setRefused(true);
        throw new Error('Provider reader changed');
      }
      return response.result;
    }
    const installed = adapters?.(admission);
    const transport: QueueTransport = installed
      ? {
          read: (...args) => {
            visit.assert();
            return installed.transport.read(...args);
          },
          prepare: (scope) => {
            visit.assert();
            return installed.transport.prepare(scope);
          },
          decide: (command) => {
            visit.assert();
            return installed.transport.decide(command);
          },
          readings: (commands) => {
            visit.assert();
            return installed.transport.readings(commands);
          },
        }
      : {
          read: (scope, cursor, nativeSession) =>
            admitted(() =>
              readProviderScopeAction({
                data: {
                  scope,
                  ...(cursor !== undefined ? { cursor } : {}),
                  ...(nativeSession ? { session: nativeSession } : {}),
                },
                headers,
              }),
            ),
          prepare: (data) => admitted(() => prepareProviderScopeAction({ data, headers })),
          decide: (data) => admitted(() => decideProviderScopeAction({ data, headers })),
          readings: (data) => admitted(() => readProviderScopeSubjectsAction({ data, headers })),
        };
    const contexts: ProviderContextSource = installed
      ? {
          search: (input) => {
            visit.assert();
            return installed.contexts.search(input);
          },
          resolve: (id) => {
            visit.assert();
            return installed.contexts.resolve(id);
          },
        }
      : {
          search: (data) => admitted(() => searchProviderContextsAction({ data, headers })),
          resolve: (id) => admitted(() => resolveProviderContextAction({ data: { id }, headers })),
        };
    return { transport, contexts };
  }, [admission, visit, adapters]);
  if (refused)
    return (
      <div className="flex flex-col gap-3 p-6">
        <p role="status">{m.prq_denied()}</p>
        <Button
          type="button"
          onClick={() => {
            if (admission && source.current(admission)) {
              setRefused(false);
              setRecovery((value) => value + 1);
            }
          }}
        >
          {m.prq_retry()}
        </Button>
      </div>
    );
  if (
    !admission ||
    !bound ||
    !visit.live() ||
    session.state !== 'signed-in' ||
    session.subject !== admission.subject ||
    session.csrfToken !== admission.csrfToken
  )
    return (
      <p role="status" className="p-6">
        {m.prq_denied()}
      </p>
    );
  return (
    <ProviderQueue
      key={`${admission.id}:${visit.id}`}
      {...bound}
      current={visit.live}
      canWrite={!!admission.csrfToken}
      initialReturn={restored?.admission === admission.id ? restored.visit : undefined}
      onReviewCandidate={(state) => {
        return visit.live() ? !!saveProviderQueueReturn(source, admission, state) : false;
      }}
    />
  );
}
