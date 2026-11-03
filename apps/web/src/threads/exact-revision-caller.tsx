import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ReadCredentialMode } from '../kernel/credential';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { EditionCreateEntry } from '../content-editions/edition-create-entry';
import { ExactRevisionView } from './exact-revision-view';
import type { ExactRevisionIdentity, ExactRevisionState } from './exact-revision';
import {
  createHistoricalReadBinding,
  historicalActualMatches,
  historicalBindingCurrent,
  historicalReaderSource,
  historicalSessionReaderReady,
  sameHistoricalReadBinding,
  type HistoricalReadBinding,
  type HistoricalReadEnvelope,
  type HistoricalReadProvenance,
  type HistoricalReaderSource,
} from './historical-reader-provenance';

export type ExactRevisionVisit = {
  admission: {
    id: string;
    identity: ExactRevisionIdentity;
    locale: string;
    credentialMode: ReadCredentialMode;
    binding: HistoricalReadBinding;
  };
  page: ExactRevisionState;
  provenance: HistoricalReadProvenance;
};

let visitSequence = 0;

function visitMatchesTarget(
  visit: ExactRevisionVisit,
  identity: ExactRevisionIdentity,
  locale: string,
  credentialMode: ReadCredentialMode,
) {
  const { admission } = visit;
  const target = admission.binding.target;
  return (
    admission.identity.postId === identity.postId &&
    admission.identity.revisionId === identity.revisionId &&
    admission.locale === locale &&
    admission.credentialMode === credentialMode &&
    target.kind === 'exact-revision' &&
    target.postId === identity.postId &&
    target.revisionId === identity.revisionId &&
    target.locale === locale &&
    target.credentialMode === credentialMode &&
    sameHistoricalReadBinding(admission.binding, visit.provenance.binding)
  );
}

function validProvenance(value: unknown): value is HistoricalReadProvenance {
  if (!value || typeof value !== 'object') return false;
  const provenance = value as Partial<HistoricalReadProvenance>;
  const actual = provenance.actualReader;
  return (
    !!provenance.binding &&
    !!actual &&
    (actual.credentialMode === 'anonymous' || actual.credentialMode === 'session') &&
    (actual.subject === null || typeof actual.subject === 'string') &&
    typeof actual.complete === 'boolean' &&
    Number.isSafeInteger(provenance.responseGeneration) &&
    (provenance.responseGeneration ?? 0) > 0
  );
}

function unavailableForProvenance(): ExactRevisionState {
  return { state: 'unavailable', status: 404 };
}

/** Capture the browser/server observation before the one original exact read and keep it on the wire. */
export async function readExactRevisionVisit(
  client: QueryClient,
  identity: ExactRevisionIdentity,
  locale: string,
  credentialMode: ReadCredentialMode,
  read: (binding: HistoricalReadBinding) => Promise<HistoricalReadEnvelope<ExactRevisionState>>,
): Promise<ExactRevisionVisit> {
  const source = historicalReaderSource(client);
  const sourceAtStart = source.read();
  const binding = createHistoricalReadBinding(
    source,
    { kind: 'exact-revision', ...identity, locale, credentialMode },
    ++visitSequence,
    0,
    1,
  );
  const admission = {
    id: binding.id,
    identity: { ...identity },
    locale,
    credentialMode,
    binding,
  };

  // Let the queued route read observe replacement/removal before it can reach the BFF.
  await Promise.resolve();
  if (
    !historicalBindingCurrent(source, binding) ||
    (credentialMode === 'session' && !historicalSessionReaderReady(sourceAtStart))
  ) {
    return {
      admission,
      page: { state: 'loading' },
      provenance: {
        binding,
        actualReader: { credentialMode: 'anonymous', subject: null, complete: false },
        responseGeneration: 0,
      },
    };
  }

  let result: HistoricalReadEnvelope<ExactRevisionState>;
  try {
    result = await read(binding);
  } catch (error) {
    if (isPlatformClosedError(error)) throw error;
    return {
      admission,
      page: { state: 'problem', status: 503, code: null },
      provenance: {
        binding,
        actualReader: { credentialMode: 'anonymous', subject: null, complete: false },
        responseGeneration: 0,
      },
    };
  }

  const provenance = validProvenance(result?.provenance) ? result.provenance : undefined;
  const bindingMatches = provenance !== undefined && sameHistoricalReadBinding(binding, provenance.binding);
  const actualMatches = bindingMatches && historicalActualMatches(binding, provenance.actualReader);
  const observationMatches = actualMatches && historicalBindingCurrent(source, binding, provenance.actualReader);
  return {
    admission,
    page: observationMatches
      ? result.data
      : bindingMatches && actualMatches
        ? { state: 'loading' }
        : unavailableForProvenance(),
    provenance: provenance ?? {
      binding,
      actualReader: { credentialMode: 'anonymous', subject: null, complete: false },
      responseGeneration: 0,
    },
  };
}

type Connection = { generation: number; connected: boolean; retired: boolean; owner: object | null };
const connections = new WeakMap<ExactRevisionVisit, Connection>();
const retiredVisits = new WeakSet<ExactRevisionVisit>();

function connectionFor(visit: ExactRevisionVisit) {
  let connection = connections.get(visit);
  if (!connection) {
    connection = { generation: 0, connected: false, retired: false, owner: null };
    connections.set(visit, connection);
  }
  return connection;
}

function retireVisit(visit: ExactRevisionVisit) {
  retiredVisits.add(visit);
  visit.page = { state: 'loading' };
  const connection = connectionFor(visit);
  connection.retired = true;
  connection.connected = false;
  connection.generation++;
}

function connect(visit: ExactRevisionVisit, owner: object) {
  const connection = connectionFor(visit);
  if (connection.owner && connection.owner !== owner) retireVisit(visit);
  if (retiredVisits.has(visit)) connection.retired = true;
  if (connection.retired) return 0;
  connection.owner = owner;
  connection.connected = true;
  return ++connection.generation;
}

function disconnect(visit: ExactRevisionVisit, generation: number) {
  const connection = connectionFor(visit);
  if (!generation || connection.generation !== generation) return;
  connection.connected = false;
  const disconnectedAt = ++connection.generation;
  // Strict Mode replays layout effects in the same turn and reconnects this visit.
  queueMicrotask(() => {
    if (connection.connected || connection.generation !== disconnectedAt) return;
    retireVisit(visit);
  });
}

function ownsConnection(visit: ExactRevisionVisit, generation: number) {
  const connection = connectionFor(visit);
  return (
    generation !== 0 &&
    connection.connected &&
    !connection.retired &&
    !retiredVisits.has(visit) &&
    connection.generation === generation
  );
}

function sessionAdmissionCurrent(visit: ExactRevisionVisit, source: HistoricalReaderSource) {
  return (
    historicalActualMatches(visit.admission.binding, visit.provenance.actualReader) &&
    historicalBindingCurrent(source, visit.admission.binding, visit.provenance.actualReader)
  );
}

export function ExactRevisionCaller({
  visit,
  identity,
  locale,
  credentialMode,
  loading,
  onRetry,
}: {
  visit: ExactRevisionVisit;
  identity: ExactRevisionIdentity;
  locale: string;
  credentialMode: ReadCredentialMode;
  loading: boolean;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const source = historicalReaderSource(queryClient);
  useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const owner = useRef<object | null>(null);
  owner.current ??= {};
  const active = useRef<{
    visit: ExactRevisionVisit;
    identity: ExactRevisionIdentity;
    locale: string;
    mode: ReadCredentialMode;
    loading: boolean;
  } | null>(null);
  const previous = active.current;
  if (
    previous &&
    (previous.visit !== visit ||
      previous.identity.postId !== identity.postId ||
      previous.identity.revisionId !== identity.revisionId ||
      previous.locale !== locale ||
      previous.mode !== credentialMode)
  ) {
    retireVisit(previous.visit);
  }
  active.current = { visit, identity, locale, mode: credentialMode, loading };

  const targetMatches = visitMatchesTarget(visit, identity, locale, credentialMode);
  const observationCurrent = historicalBindingCurrent(source, visit.admission.binding, visit.provenance.actualReader);
  const admissionMatches = targetMatches && sessionAdmissionCurrent(visit, source);
  const generationCurrent = targetMatches && observationCurrent;
  if (!generationCurrent && !retiredVisits.has(visit)) retireVisit(visit);
  const page =
    loading || retiredVisits.has(visit) || !admissionMatches
      ? !loading && targetMatches && generationCurrent
        ? visit.page.state === 'ready'
          ? unavailableForProvenance()
          : visit.page
        : { state: 'loading' as const }
      : visit.page;

  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    const current = connect(visit, owner.current!);
    setGeneration(current);
    const stop = source.subscribe(() => {
      if (!historicalBindingCurrent(source, visit.admission.binding, visit.provenance.actualReader)) retireVisit(visit);
    });
    return () => {
      stop();
      disconnect(visit, current);
    };
  }, [visit, source]);

  const retry = () => {
    const current = active.current;
    const observation = source.read();
    if (
      current?.visit !== visit ||
      current.identity.postId !== identity.postId ||
      current.identity.revisionId !== identity.revisionId ||
      current.locale !== locale ||
      current.mode !== credentialMode ||
      current.loading ||
      !ownsConnection(visit, generation) ||
      !targetMatches ||
      !historicalBindingCurrent(source, visit.admission.binding) ||
      (credentialMode === 'session' && !historicalSessionReaderReady(observation))
    )
      return;
    retireVisit(visit);
    onRetry();
  };

  const ready =
    page.state === 'ready' && admissionMatches && ownsConnection(visit, generation) && !retiredVisits.has(visit);
  return (
    <>
      <ExactRevisionView identity={identity} page={page} onRetry={retry} readingIdentity={visit}
        isReadingCurrent={() => active.current?.visit === visit && !retiredVisits.has(visit) &&
          ownsConnection(visit, generation) && historicalBindingCurrent(source, visit.admission.binding)} />
      {ready ? <EditionCreateEntry identity={identity} /> : null}
    </>
  );
}
