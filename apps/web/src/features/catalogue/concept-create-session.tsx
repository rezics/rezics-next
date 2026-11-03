import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { PageHeading } from '../../shell/page-heading';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { editorRequest } from './editor-request';
import { CreateSubjectForm } from './create-subject-form';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import type { CreateResult, CreateType, InitialSubject } from './create-subject';
import { relationTargetSearch } from './relation-editor-search';
import { createCatalogueConcept, loadConceptCreate } from './concept-create-actions';
import {
  conceptAdmitCreatedReader,
  conceptCreateControl,
  conceptCreateDraft,
  conceptCreateHolders,
  conceptCreatePreparedFacts,
  conceptCreateTypes,
  conceptGrain,
  type ConceptCreateCommand,
  type ConceptCreateFact,
  type ConceptCreateItem,
  type ConceptCreateRead,
} from './concept-create';
import { ConceptCreateFields } from './concept-create-fields';
import { ConceptCreateReview } from './concept-create-review';
import {
  beginClassificationDraftReturn,
  beginClassificationReturn,
  classificationReturnHref,
  classificationTargetAdmitted,
  discardClassificationCreateHandoff,
  readClassificationCreateHandoff,
  recordCreatedClassificationIdentity,
  type ClassificationCreateHandoff,
  type CreatedClassificationIdentity,
} from './classification-create-return';

type ReadyRead = Extract<ConceptCreateRead, { ok: true }>;
type Created = Extract<CreateResult, { ok: true }>;
type Metadata = { ready: boolean; pending: boolean; failure: ReactNode; types: CreateType[] };
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
const factsId = 'concept-initial-facts';
const formClass =
  'inline-flex min-h-11 min-w-11 items-center justify-center whitespace-normal rounded-md border px-4 py-2';

function createdIdentity(result: Created, bases: string[]): CreatedClassificationIdentity | undefined {
  const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
  if (!identity) return undefined;
  return { id: identity.id, type: identity.type, label: identity.label, bases };
}

function ConceptCreateSessionLive({
  locale,
  initial,
  token,
}: {
  locale: string;
  initial: ConceptCreateRead;
  token?: string;
}) {
  const work = useCatalogueLifetime('concept-create');
  const { state, csrfToken, subject } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const [reading, setReading] = useState<ConceptCreateRead>(initial);
  const lastGood = useRef<ReadyRead | undefined>(initial.ok ? initial : undefined);
  const [pending, setPending] = useState(false);
  const [termDrafts, setTermDrafts] = useState<Record<string, boolean>>({});
  const [factsByType, setFactsByType] = useState<Record<string, ConceptCreateFact[]>>({});
  const [archived, setArchived] = useState<CreateType[]>([]);
  const [handoff, setHandoff] = useState<ClassificationCreateHandoff>();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const returning = useRef(false);
  const selectedBases = useRef<string[]>([]);
  const titleId = useId();
  const refreshing = useRef(false);
  const prepared = useRef<
    | {
        release: Release;
        digest: string;
        holders: ReturnType<typeof conceptCreateHolders>;
      }
    | undefined
  >(undefined);
  const o = { locale: locale as never };

  useEffect(() => {
    if (!token) {
      setHandoff(undefined);
      return;
    }
    returning.current = false;
    const current = readClassificationCreateHandoff(token);
    if (!current || current.phase !== 'creating' || current.reader !== work.reader || !work.live()) {
      discardClassificationCreateHandoff(token);
      setHandoff(undefined);
      return;
    }
    setHandoff(current);
    return () => {
      if (!returning.current) discardClassificationCreateHandoff(token);
    };
  }, [token, work]);

  const retainedTypes = new Set([
    ...Object.entries(termDrafts)
      .filter(([, retained]) => retained)
      .map(([type]) => type),
    ...Object.entries(factsByType)
      .filter(([, rows]) => rows.length > 0)
      .map(([type]) => type),
  ]);
  const currentRead = reading.ok ? reading : lastGood.current;
  const release = currentRead?.release;
  const activeTypes = reading.ok
    ? conceptCreateTypes(reading.release, locale).filter((entry) =>
        handoff ? classificationTargetAdmitted(entry.id, entry.bases ?? [], handoff.targets) : true,
      )
    : [];
  const currentIds = new Set(activeTypes.map((entry) => entry.id));
  const archivedTypes = archived.filter((entry) => retainedTypes.has(entry.id) && !currentIds.has(entry.id));
  const types = reading.ok
    ? [...activeTypes, ...archivedTypes]
    : currentRead
      ? conceptCreateTypes(currentRead.release, locale)
      : [];
  const metadata: Metadata = {
    ready: reading.ok,
    pending,
    failure: <p>{m.concept_create_unavailable({}, o)}</p>,
    types,
  };
  const metadataRevision = reading.ok ? reading.digest : (currentRead?.digest ?? 'unavailable');
  const activeTypeIds = new Set(activeTypes.map((entry) => entry.id));

  async function refreshMetadata() {
    if (!work.active() || refreshing.current) return;
    refreshing.current = true;
    setPending(true);
    try {
      const result = await loadConceptCreate({ data: true });
      if (!work.active()) return;
      if (result.ok) {
        const previous = lastGood.current;
        if (previous) {
          const admitted = new Set(conceptCreateTypes(result.release, locale).map((entry) => entry.id));
          const previousTypes = conceptCreateTypes(previous.release, locale).filter(
            (entry) => retainedTypes.has(entry.id) && !admitted.has(entry.id),
          );
          setArchived((current) => {
            const combined = new Map(current.map((entry) => [entry.id, entry]));
            for (const entry of previousTypes) combined.set(entry.id, entry);
            return [...combined.values()];
          });
        }
        lastGood.current = result;
      }
      setReading(result);
    } catch {
      if (!work.active()) return;
      setReading({ ok: false });
    } finally {
      refreshing.current = false;
      if (work.active()) setPending(false);
    }
  }

  function recordCreated(result: Created) {
    const current = handoff;
    if (!current || !work.live()) return;
    const next = recordCreatedClassificationIdentity(
      current.token,
      current.sourceId,
      current.reader,
      result.id,
      createdIdentity(result, selectedBases.current),
    );
    if (!next) {
      discardClassificationCreateHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    setHandoff(next);
  }

  function returnWithIdentity(identity: CreatedClassificationIdentity) {
    const current = handoff;
    if (
      !current ||
      current.identity?.id !== identity.id ||
      current.reader !== work.reader ||
      !work.live() ||
      !beginClassificationReturn(current.token, current.sourceId, work.reader)
    ) {
      if (current) discardClassificationCreateHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    returning.current = true;
    window.location.assign(classificationReturnHref(current.returnPath, current.token));
  }

  function returnDraft() {
    const current = handoff;
    if (!current || !work.live() || !beginClassificationDraftReturn(current.token, current.sourceId, work.reader)) {
      if (current) discardClassificationCreateHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    returning.current = true;
    window.location.assign(classificationReturnHref(current.returnPath, current.token));
  }

  const transport = useMemo(
    () => ({
      submit: (command: { item: InitialSubject; key: string }) =>
        createCatalogueConcept({
          data: editorRequest(command as ConceptCreateCommand, work),
          headers: csrfHeaders(),
        }),
      read: async (id: string) => {
        const reader = await readCreatedCatalogueSubject({ data: id });
        if (!reading.ok || reader.state !== 'ready' || !reader.identity) return reader;
        return conceptAdmitCreatedReader(reader, id, reading.release, reader.identity.type);
      },
    }),
    [reading, work],
  );

  const fields = (
    type: string,
    disabled: boolean,
    canEdit: () => boolean,
    invalidate?: () => void,
    discard?: () => void,
  ) => {
    if (!release) return null;
    return (
      <ConceptCreateFields
        type={type}
        release={release}
        locale={locale}
        search={search}
        facts={factsByType[type] ?? []}
        disabled={disabled || metadata.pending}
        canEdit={canEdit}
        invalidate={invalidate ?? (() => undefined)}
        discardTypeDraft={discard ?? (() => undefined)}
        change={(next) => {
          setFactsByType((current) => {
            const copy = { ...current };
            if (next.length) copy[type] = next;
            else delete copy[type];
            return copy;
          });
        }}
      />
    );
  };

  const profile = useMemo(
    () =>
      release
        ? {
            title: m.concept_create_title({}, o),
            intro: m.concept_create_intro({}, o),
            href: `/${locale}/catalogue/concept`,
            scope: 'concept-create',
            metadata,
            refreshMetadata,
            retainTypeDrafts: true,
            identitySearch: true,
            releaseDigest: reading.ok ? reading.digest : currentRead?.digest,
            initialLanguage: '',
            reviewRevision: metadataRevision,
            onTypeDraftChange: (type: string, hasTerms: boolean) => {
              if (!type) return;
              setTermDrafts((current) => {
                const next = { ...current };
                if (hasTerms) next[type] = true;
                else delete next[type];
                return next;
              });
            },
            onDiscardType: (type: string) => {
              setTermDrafts((current) => {
                const next = { ...current };
                delete next[type];
                return next;
              });
              setFactsByType((current) => {
                const next = { ...current };
                delete next[type];
                return next;
              });
            },
            canEditType: (type: string) =>
              reading.ok && activeTypeIds.has(type) && conceptGrain(reading.release, type) !== undefined,
            canCreateType: (type: string) => reading.ok && activeTypeIds.has(type),
            labelLanguage: (type: string) => pickText(release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type: string) =>
              pickText(release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            fields,
            prepare: (initialItem: InitialSubject) => {
              const facts = conceptCreatePreparedFacts(factsByType[initialItem.type] ?? [], release);
              const result = conceptCreateDraft(release, initialItem, facts);
              prepared.current = {
                release,
                digest: reading.ok ? reading.digest : metadataRevision,
                holders: conceptCreateHolders(facts),
              };
              return result;
            },
            control: (pointer: string, type: string) => {
              const snapshot = prepared.current;
              if (!snapshot) return undefined;
              return conceptCreateControl(
                pointer,
                snapshot.holders,
                factsByType[type] ?? [],
                type,
                snapshot.release,
                locale,
                factsId,
              );
            },
            review: (state: { item: InitialSubject; stale: boolean }) => {
              const snapshot = prepared.current;
              if (!snapshot) return null;
              return (
                <ConceptCreateReview
                  item={state.item as ConceptCreateItem}
                  holders={snapshot.holders}
                  release={snapshot.release}
                  locale={locale}
                  stale={state.stale || !metadata.ready || snapshot.digest !== metadataRevision}
                  factsId={factsId}
                  onJump={(id) => {
                    const target = document.getElementById(id);
                    if (!target) return;
                    for (let parent = target.parentElement; parent; parent = parent.parentElement)
                      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
                    const control = target.matches('input, select, textarea, button')
                      ? target
                      : target.querySelector<HTMLElement>(
                          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
                        );
                    (control ?? target).focus();
                    target.scrollIntoView({ block: 'center' });
                  }}
                />
              );
            },
          }
        : undefined,
    [
      activeTypeIds,
      factsByType,
      fields,
      locale,
      metadata,
      metadataRevision,
      o,
      reading,
      release,
      retainedTypes,
      search,
    ],
  );

  const returnedIdentity = handoff?.phase === 'ready' ? handoff.identity : undefined;
  const identityIntake = {
    viewerKey: JSON.stringify([state, subject ?? '', csrfToken ?? '']),
    viewerState: state as Session,
  };

  if (!release || !profile) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.concept_create_title({}, o)}</PageHeading>
        {token && !handoff && <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>}
        {reading.ok ? (
          <p role="status">{m.concept_create_absent({}, o)}</p>
        ) : (
          <div role="alert" className="space-y-3">
            <p>{m.concept_create_unavailable({}, o)}</p>
            <Button
              type="button"
              variant="outline"
              className={formClass}
              disabled={pending}
              onClick={() => void refreshMetadata()}
            >
              {m.catalogue_create_retry({}, o)}
            </Button>
          </div>
        )}
      </article>
    );
  }

  if (reading.ok && activeTypes.length === 0 && retainedTypes.size === 0) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.concept_create_title({}, o)}</PageHeading>
        {token && !handoff && <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>}
        <p>{m.concept_create_intro({}, o)}</p>
        <p role="status">{m.concept_create_absent({}, o)}</p>
      </article>
    );
  }

  return (
    <div className="space-y-6">
      {token && !handoff && <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>}
      {handoff && (
        <section
          aria-labelledby={titleId}
          className="mx-auto max-w-3xl space-y-3 rounded-xl border border-border bg-muted/30 p-4"
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {m.classification_create_source({}, o)}
          </h2>
          <p>{m.classification_create_context({ relation: handoff.propertyLabel, source: handoff.sourceLabel }, o)}</p>
          <p className="text-sm text-muted-foreground">{m.classification_create_distinct({}, o)}</p>
        </section>
      )}
      {reading.ok && activeTypes.length === 0 && (
        <p role="status" className="mx-auto mb-4 max-w-3xl px-4">
          {m.concept_create_absent({}, o)}
        </p>
      )}
      <CreateSubjectForm
        locale={locale}
        session={state}
        transport={{
          ...transport,
          submit: async (command) => {
            const type = types.find((entry) => entry.id === command.item.type);
            if (type) selectedBases.current = type.bases ?? [];
            return transport.submit(command);
          },
          read: transport.read,
        }}
        onCreated={(result) => {
          if (handoff) recordCreated(result);
        }}
        onNavigate={handoff ? () => {} : (href) => window.location.assign(href)}
        identityIntake={identityIntake}
        profile={profile}
        {...(handoff
          ? {
              typeAdmission: {
                offered: activeTypes,
                unavailable: handoff.targets.filter(
                  (target) =>
                    !activeTypes.some((entry) => classificationTargetAdmitted(entry.id, entry.bases ?? [], [target])),
                ),
                admitType: (type: CreateType) => {
                  const admitted = classificationTargetAdmitted(type.id, type.bases ?? [], handoff.targets);
                  if (admitted) selectedBases.current = type.bases ?? [];
                  return admitted;
                },
              },
            }
          : {})}
      />
      {returnedIdentity && (
        <div className="mx-auto max-w-3xl px-4">
          <Button type="button" variant="outline" onClick={() => returnWithIdentity(returnedIdentity)}>
            {m.classification_create_return_to_draft({}, o)}
          </Button>
        </div>
      )}
      {handoff && handoff.phase === 'creating' && !handoff.createdId && (
        <div className="mx-auto max-w-3xl px-4">
          <Button type="button" variant="outline" onClick={() => setConfirmLeave(true)}>
            {m.classification_create_cancel({}, o)}
          </Button>
        </div>
      )}
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.classification_create_cancel({}, o)}</AlertDialogTitle>
            <AlertDialogDescription>{m.classification_create_cancel_confirm({}, o)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.thread_authoring_stay({}, o)}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={returnDraft}>
              {m.classification_create_cancel({}, o)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const ConceptCreateSession = candidateSession(ConceptCreateSessionLive);
