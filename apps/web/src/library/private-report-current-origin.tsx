import { useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { viewerExposureLifetime, viewerExposureQuery, type ViewerExposure } from '../kernel/viewer-exposure';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery, useSession } from '../session/query';

type Session = ReturnType<typeof useSession>;
const idleSubscribe = () => () => {};
const groups = [
  'personal_library',
  'library_entry.restore',
  'reading_progress',
  'library_label.assignment_list',
  'library_label.unassign',
] as const;
export type ReportGroup = (typeof groups)[number];

/** Local composition for the named-label shelf and count report, using the shared viewer observer. */
export function usePrivateReportOrigin(
  address: string,
  locale: string,
  addressAt: (href: string) => string,
  requireMutationCredential = true,
) {
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  useSession();
  const hydrated = useSyncExternalStore(
    idleSubscribe,
    () => true,
    () => false,
  );
  const origin = useMemo(() => {
    const lifetime = viewerExposureLifetime(client);
    const id = crypto.randomUUID();
    let bound = address;
    let actual = address;
    let boundLocale = locale;
    let locate = addressAt;
    let ownerKey = '';
    let retainedSubject: string | null = null;
    let signature = '';
    let mounted = 0;
    let value = {
      owner: 0,
      mount: 0,
      unavailable: false,
      subject: null as string | null,
      csrfToken: '',
      authority: false,
      state: 'unknown' as Session['state'],
      observation: undefined as { subject: string; id: number } | undefined,
      admitted: groups.map(() => false),
      versions: groups.map(() => 0),
    };
    const server = value;
    const read = () => {
      const session = client.getQueryState<Session>(sessionQuery.queryKey);
      const viewer = session?.status === 'success' ? session.data : undefined;
      const subject =
        viewer?.state === 'signed-in' &&
        viewer.subject?.trim() &&
        (!requireMutationCredential || viewer.csrfToken?.trim())
          ? viewer.subject
          : null;
      const snapshot = lifetime.getSnapshot();
      const observation = snapshot.state === 'signed-in' ? snapshot.observation : undefined;
      const exposure = client.getQueryState<ViewerExposure>(viewerExposureQuery(observation).queryKey);
      const authority =
        !!subject &&
        observation?.subject === subject &&
        exposure?.status === 'success' &&
        exposure.data?.subject === subject;
      const admitted = groups.map((group) => authority && exposure!.data!.admitted.includes(group));
      // Uncertainty suspends authority without replacing an already prepared command. A known
      // different viewer, sign-out or source change still permanently discards that payload.
      if (viewer?.state === 'signed-out') retainedSubject = null;
      else if (viewer?.state === 'signed-in' && viewer.subject?.trim()) retainedSubject = viewer.subject;
      const unavailable =
        session?.status === 'error' ||
        (viewer?.state === 'signed-in' && !subject) ||
        viewer?.state === 'unavailable' ||
        exposure?.status === 'error' ||
        (exposure?.status === 'success' && !authority);
      const nextOwner = JSON.stringify([retainedSubject, actual, boundLocale, getLocale()]);
      const next = JSON.stringify([
        nextOwner,
        mounted,
        unavailable,
        subject,
        viewer?.state,
        viewer?.csrfToken,
        observation?.id,
        authority,
        admitted,
      ]);
      if (next !== signature) {
        value = {
          owner: value.owner + (nextOwner === ownerKey ? 0 : 1),
          mount: mounted,
          unavailable,
          subject,
          authority,
          csrfToken: subject ? (viewer!.csrfToken ?? '') : '',
          state: viewer?.state ?? 'unknown',
          observation,
          admitted,
          versions: value.versions.map(
            (version, index) => version + (admitted[index] === value.admitted[index] ? 0 : 1),
          ),
        };
        signature = next;
        ownerKey = nextOwner;
      }
      return value;
    };
    return {
      read,
      server: () => server,
      bind(next: string, nextLocale: string, nextLocate: typeof addressAt) {
        if (next !== bound || nextLocale !== boundLocale) {
          bound = next;
          actual = next;
          boundLocale = nextLocale;
        }
        locate = nextLocate;
      },
      version(...required: ReportGroup[]) {
        const current = read();
        return JSON.stringify([
          id,
          current.owner,
          current.mount,
          current.observation?.id,
          required.map((group) => current.versions[groups.indexOf(group)]),
        ]);
      },
      capture(...required: ReportGroup[]) {
        const current = read();
        const version = this.version(...required);
        const allowed = required.every((group) => current.admitted[groups.indexOf(group)]);
        return () =>
          allowed &&
          this.version(...required) === version &&
          required.every((group) => read().admitted[groups.indexOf(group)]);
      },
      subscribe(notify: () => void) {
        const changed = () => {
          const previous = value;
          read();
          if (previous !== value) notify();
        };
        // The shared lifetime observes every session replacement synchronously, even a batched A-B-A.
        const session = lifetime.subscribe(changed);
        const cache = client.getQueryCache().subscribe(({ query }) => {
          if (query.queryKey[0] === 'session' || query.queryKey[0] === 'exposure') changed();
        });
        const navigation = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
          actual = locate(toLocation.publicHref);
          changed();
        });
        changed();
        return () => {
          // Cleanup only retires. A later setup cannot restore any captured episode.
          mounted++;
          read();
          navigation?.();
          cache();
          session();
        };
      },
    };
  }, [client, router, requireMutationCredential]);
  origin.bind(address, locale, addressAt);
  const value = useSyncExternalStore(origin.subscribe, origin.read, origin.server);
  useQuery({ ...viewerExposureQuery(value.observation), enabled: hydrated && value.observation !== undefined });
  return { origin, value, hydrated };
}

/** A retained form also belongs to one successful payload, not merely its viewer and address. */
export function usePrivateReportPayload(client: QueryClient, key: QueryKey) {
  const identity = JSON.stringify(key);
  const observation = useMemo(() => {
    let previous = client.getQueryState(key);
    let version = 0;
    const read = () => {
      const next = client.getQueryState(key);
      if (
        next?.status !== previous?.status ||
        next?.data !== previous?.data ||
        next?.dataUpdatedAt !== previous?.dataUpdatedAt
      )
        version++;
      previous = next;
      return version;
    };
    return {
      read,
      server: () => 0,
      subscribe: (notify: () => void) =>
        client.getQueryCache().subscribe(({ query }) => {
          if (JSON.stringify(query.queryKey) !== identity) return;
          const before = version;
          if (read() !== before) notify();
        }),
    };
  }, [client, identity]);
  const version = useSyncExternalStore(observation.subscribe, observation.read, observation.server);
  return (data: unknown, successful = true) =>
    () => {
      const state = client.getQueryState(key);
      return (
        observation.read() === version && !!state && (!successful || state.status === 'success') && state.data === data
      );
    };
}
