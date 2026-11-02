import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useMemo, useSyncExternalStore } from 'react';
import { operationIsAdmitted } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery, type ViewerExposure } from '../kernel/viewer-exposure';
import { sessionQuery, type useSession } from '../session/query';
import type { SubjectReference } from './subject-ref';
import { subjectSlotReturnTo } from './subject-slot-return-context';

type Operation = Parameters<typeof operationIsAdmitted>[0];
export type SlotFamily = 'entry' | 'labels' | 'collections';
export type SlotLifetime = { seed: string; active: boolean; current: (...operations: Operation[]) => boolean };
const operations = {
  entry: ['library_entry.get', 'library_entry.put', 'library_entry.delete', 'library_entry.restore'],
  labels: [
    'library_label.assignment_list',
    'library_label.list',
    'library_label.assign',
    'library_label.create',
    'library_label.unassign',
  ],
  collections: ['collection.list', 'collection_member.create'],
} as const;
const families = ['entry', 'labels', 'collections'] as const;

/** One owning address, observing actual scoped admission synchronously, including transitions batched by React. */
export function useSubjectLibraryObservation(subject: SubjectReference, locale: string) {
  const client = useQueryClient();
  const router = useRouter();
  const observation = useMemo(() => {
    const exposureLifetime = viewerExposureLifetime(client);
    let address = subjectSlotReturnTo(router.state.location.publicHref, subject, locale);
    let mounted = false;
    let value = {
      scope: 0,
      entry: 0,
      labels: 0,
      collections: 0,
      entrySeed: 0,
      labelsSeed: 0,
      collectionsSeed: 0,
      sessionReady: false,
      entryAdmitted: false,
      labelsAdmitted: false,
      collectionsAdmitted: false,
      viewer: null as string | null,
      credential: null as string | null,
      admitted: undefined as readonly string[] | undefined,
    };
    const server = value;
    let identity: string | undefined;
    let episode: string | undefined;
    let exposureData: unknown;
    let validGates: Partial<Record<SlotFamily, string>> = {};
    let previousGates: Partial<Record<SlotFamily, string>> = {};
    let invalid = false;
    const read = () => {
      const session = client.getQueryState<ReturnType<typeof useSession>>(sessionQuery.queryKey);
      const viewer = session?.data;
      const sessionReady =
        session?.status === 'success' &&
        viewer?.state === 'signed-in' &&
        typeof viewer.subject === 'string' &&
        !!viewer.subject;
      const snapshot = exposureLifetime.getSnapshot();
      const enrolled = snapshot.state === 'signed-in' ? snapshot.observation : undefined;
      const exposure = enrolled
        ? client.getQueryState<ViewerExposure>(viewerExposureQuery(enrolled).queryKey)
        : undefined;
      const admitted =
        sessionReady &&
        enrolled !== undefined &&
        enrolled.subject === viewer.subject &&
        exposure?.status === 'success' &&
        exposure.data?.subject === enrolled.subject
          ? exposure.data.admitted
          : undefined;
      const nextIdentity = JSON.stringify([address, sessionReady, sessionReady ? viewer.subject : null]);
      const nextEpisode = JSON.stringify([
        mounted,
        enrolled?.id,
        sessionReady ? viewer.csrfToken : null,
        session?.dataUpdateCount,
        exposure?.dataUpdateCount,
        exposure?.status,
      ]);
      // A new enrolled query may be pending during a healthy rotation. It closes dispatch, but does not
      // discard an already accepted same-reader intent. An error or a foreign successful read does.
      const nextInvalid = !!enrolled && (exposure?.status === 'error' || (exposure?.status === 'success' && !admitted));
      const identityChanged = identity !== undefined && nextIdentity !== identity;
      const changed = nextEpisode !== episode || exposureData !== exposure?.data;
      const next = {
        ...value,
        sessionReady,
        viewer: sessionReady ? viewer.subject! : null,
        credential: sessionReady ? viewer.csrfToken : null,
        admitted,
        entryAdmitted: operationIsAdmitted('library_entry.get', admitted),
        labelsAdmitted: operationIsAdmitted('library_label.assignment_list', admitted),
        collectionsAdmitted: operationIsAdmitted('collection.list', admitted),
      };
      if (identityChanged) {
        next.scope++;
        validGates = {};
      }
      const nextGates = Object.fromEntries(
        families.map((family) => [
          family,
          JSON.stringify(operations[family].map((operation) => operationIsAdmitted(operation, admitted))),
        ]),
      );
      const gateChange = families.some((family) => previousGates[family] !== nextGates[family]);
      for (const family of families) {
        const gates = nextGates[family]!;
        if (identityChanged || (changed && !gateChange) || previousGates[family] !== gates) next[family]++;
        if (
          identityChanged ||
          (nextInvalid && !invalid) ||
          (admitted && validGates[family] !== undefined && validGates[family] !== gates)
        )
          next[`${family}Seed`]++;
        previousGates[family] = gates;
        if (admitted) validGates[family] = gates;
      }
      identity = nextIdentity;
      episode = nextEpisode;
      exposureData = exposure?.data;
      invalid = nextInvalid;
      if (Object.keys(next).some((key) => next[key as keyof typeof next] !== value[key as keyof typeof value]))
        value = next;
      return value;
    };
    return {
      owner: crypto.randomUUID(),
      read,
      server: () => server,
      isMounted: () => mounted,
      subscribe: (notify: () => void) => {
        mounted = true;
        const reconcile = () => {
          const before = value;
          if (read() !== before) notify();
        };
        const cache = client.getQueryCache().subscribe(({ query, type }) => {
          if (query.queryKey[0] !== 'session' && query.queryKey[0] !== 'exposure') return;
          const enrolled = exposureLifetime.getSnapshot();
          if (
            type === 'removed' &&
            enrolled.state === 'signed-in' &&
            JSON.stringify(query.queryKey) === JSON.stringify(viewerExposureQuery(enrolled.observation).queryKey)
          ) {
            // Removal of the current successful observation is a retirement, never a reusable seed.
            value = {
              ...value,
              entrySeed: value.entrySeed + 1,
              labelsSeed: value.labelsSeed + 1,
              collectionsSeed: value.collectionsSeed + 1,
            };
          }
          reconcile();
        });
        const stopExposure = exposureLifetime.subscribe(reconcile);
        const navigation = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          const next = subjectSlotReturnTo(toLocation.publicHref, subject, locale);
          if (address !== next) {
            address = next;
            reconcile();
          }
        });
        reconcile();
        return () => {
          mounted = false;
          cache();
          navigation();
          stopExposure();
          // Setup never reactivates an episode retired by cleanup, including StrictMode replay.
          value = {
            ...value,
            entry: value.entry + 1,
            labels: value.labels + 1,
            collections: value.collections + 1,
          };
          episode = undefined;
        };
      },
    };
  }, [client, router, subject.id, subject.type, locale]);
  const value = useSyncExternalStore(observation.subscribe, observation.read, observation.server);
  return { ...observation, value };
}
