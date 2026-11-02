import { QueryClient, QueryClientContext, useQuery, type QueryKey } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import {
  viewerExposureLifetime,
  viewerExposureQuery,
  type ViewerExposure,
  type ViewerObservation,
} from '../kernel/viewer-exposure';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery, useSession } from '../session/query';

export type CollectionOperation =
  | Extract<GatedOperation, `collection.${string}` | `collection_member.${string}`>
  | 'collection_member.restore'
  | 'collection_member.batch_remove'
  | 'collection_member.transfer';
type Session = ReturnType<typeof useSession>;
const preview = new QueryClient();
const idle = () => () => {};

/** Owning Collection composition: permission episodes may end without discarding a private command. */
export function useCollectionCurrentAdmission(address: string, evidence = '', queryKey?: QueryKey) {
  const client = useContext(QueryClientContext);
  const router = useRouter({ warn: false });
  const hydrated = useSyncExternalStore(
    idle,
    () => true,
    () => false,
  );
  const store = useMemo(() => {
    const lifetime = client ? viewerExposureLifetime(client) : undefined;
    let bound = address;
    let locale = getLocale();
    let nativeEvidence = evidence;
    let sourceKey = queryKey;
    const sourceSignature = () => {
      const state = sourceKey ? client?.getQueryState(sourceKey) : undefined;
      const page = state?.data as { visibility?: unknown; viewerActions?: unknown } | undefined;
      return JSON.stringify([state?.status, page?.visibility !== null, page?.viewerActions]);
    };
    let source = sourceSignature();
    let subject: string | null = null;
    let owner = 0;
    let mount = 0;
    let active = false;
    let signature = '';
    let href = router?.state.location.publicHref;
    let value = {
      owner,
      mount,
      episode: 0,
      active,
      subject: subject as string | null,
      csrfToken: '',
      admitted: [] as readonly string[],
      observation: undefined as ViewerObservation | undefined,
    };
    const server = value;
    const read = () => {
      const session = client?.getQueryState<Session>(sessionQuery.queryKey);
      const data = session?.data;
      // Errors and missing credentials suspend dispatch. Only a known viewer/sign-out replaces private intent.
      const nextSubject =
        data?.state === 'signed-out' ? null : data?.state === 'signed-in' && data.subject ? data.subject : subject;
      if (nextSubject !== subject) {
        subject = nextSubject;
        owner++;
      }
      const enrolled = lifetime?.getSnapshot();
      const observation = enrolled?.state === 'signed-in' ? enrolled.observation : undefined;
      const exposure = client?.getQueryState<ViewerExposure>(viewerExposureQuery(observation).queryKey);
      const pageState = sourceKey ? client?.getQueryState(sourceKey) : undefined;
      const page = pageState?.data as { visibility?: unknown; viewerActions?: unknown } | undefined;
      const sameSource =
        !pageState ||
        (pageState.status === 'success' &&
          JSON.stringify([page?.visibility !== null, page?.viewerActions]) === nativeEvidence);
      const readable =
        sameSource &&
        session?.status === 'success' &&
        data?.state === 'signed-in' &&
        data.subject === subject &&
        observation?.subject === subject &&
        exposure?.status === 'success' &&
        exposure.data?.subject === subject;
      const csrfToken = readable && data?.csrfToken?.trim() ? data.csrfToken : '';
      const admitted = readable ? exposure!.data!.admitted : [];
      const next = JSON.stringify([
        owner,
        mount,
        active,
        session?.status,
        data?.state,
        subject,
        csrfToken,
        observation?.id,
        exposure?.status,
        admitted,
        nativeEvidence,
        locale,
        getLocale(),
      ]);
      if (signature !== next) {
        value = { owner, mount, active, subject, csrfToken, admitted, observation, episode: value.episode + 1 };
        signature = next;
      }
      return value;
    };
    return {
      read,
      server: () => server,
      bind(next: string, nextEvidence: string, nextKey?: QueryKey) {
        if (bound !== next || locale !== getLocale()) {
          bound = next;
          locale = getLocale();
          owner++;
        }
        if (JSON.stringify(sourceKey) !== JSON.stringify(nextKey)) {
          sourceKey = nextKey;
          source = sourceSignature();
        }
        nativeEvidence = nextEvidence;
      },
      subscribe(notify: () => void) {
        const changed = () => {
          const previous = value;
          read();
          if (previous !== value) notify();
        };
        active = true;
        const stopLifetime = lifetime?.subscribe(changed);
        const stopCache = client?.getQueryCache().subscribe(({ query }) => {
          if (sourceKey && JSON.stringify(query.queryKey) === JSON.stringify(sourceKey)) {
            const next = sourceSignature();
            if (next !== source) {
              // Retire responses/callbacks even if the same payload returns before React commits.
              mount++;
              source = next;
            }
          }
          changed();
        });
        const stopNavigation = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if (href !== toLocation.publicHref) {
            href = toLocation.publicHref;
            owner++;
          }
          changed();
        });
        changed();
        return () => {
          active = false;
          mount++;
          owner++;
          read();
          stopNavigation?.();
          stopCache?.();
          stopLifetime?.();
        };
      },
    };
  }, [client, router]);
  store.bind(address, evidence, queryKey);
  const value = useSyncExternalStore(store.subscribe, store.read, store.server);
  useQuery(
    { ...viewerExposureQuery(value.observation), enabled: hydrated && !!client && !!value.observation },
    client ?? preview,
  );
  const retained = () => {
    const actual = store.read();
    return actual.active && actual.owner === value.owner;
  };
  const observed = () => {
    const actual = store.read();
    return hydrated && retained() && actual.mount === value.mount && actual.episode === value.episode;
  };
  const current = (operation: CollectionOperation) => {
    const actual = store.read();
    // These existing native routes use the same installed collections exposure group.
    // Their exact operation names are still checked independently against page viewerActions.
    const exposedOperation =
      operation === 'collection_member.restore' ||
      operation === 'collection_member.batch_remove' ||
      operation === 'collection_member.transfer'
        ? 'collection.get'
        : operation;
    return (
      observed() &&
      (operation === 'collection.get' || !!actual.csrfToken) &&
      operationIsAdmitted(exposedOperation, actual.admitted)
    );
  };
  return {
    owner: value.owner,
    retained,
    observed,
    current,
    csrf: (operation: CollectionOperation) => (current(operation) ? store.read().csrfToken || null : null),
  };
}

export type CollectionAdmission = ReturnType<typeof useCollectionCurrentAdmission>;
