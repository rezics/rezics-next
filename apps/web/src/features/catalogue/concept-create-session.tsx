import { useCreationHost } from './creation-host/use-creation-host';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
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
import { candidateSession } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { editorRequest } from './editor-request';
import { CreateSubjectForm } from './create-subject-form';
import { readCatalogueCreateEligibility, readCreatedCatalogueSubject } from './create-subject-actions';
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
  readClassificationCreateAcknowledgement,
  readClassificationCreateHandoff,
  recordClassificationCreateAcknowledgement,
  recordCreatedClassificationIdentity,
  type ClassificationCreateHandoff,
  type CreatedClassificationIdentity,
} from './classification-create-return';

type Created = Extract<CreateResult, { ok: true }>;
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
const factsId = 'concept-initial-facts';
const formClass =
  'inline-flex min-h-11 min-w-11 items-center justify-center whitespace-normal rounded-md border px-4 py-2';

function createdIdentity(result: Created, reading: ConceptCreateRead): CreatedClassificationIdentity | undefined {
  const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
  if (!reading.ok || !identity || identity.id !== result.id) return undefined;
  const type = reading.release.types[identity.type];
  if (!type || !conceptGrain(reading.release, identity.type)) return undefined;
  return {
    id: identity.id,
    type: identity.type,
    label: identity.label,
    bases: (type.bases ?? []).filter((base) => typeof base === 'string' && base.length > 0),
  };
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
  const { state, csrfToken, subject } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const [handoff, setHandoff] = useState<ClassificationCreateHandoff>();
  const [restoration, setRestoration] = useState<{ token: string; reader: string; id?: string }>();
  const [disclosure, setDisclosure] = useState<
    { visitKey: string; reader: string; identity: CreatedClassificationIdentity } | undefined
  >();
  const [returnReadFailure, setReturnReadFailure] = useState<Created['reader']['state']>();
  const [returnPending, setReturnPending] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const returning = useRef(false);
  const titleId = useId();
  const o = { locale: locale as never };
  const host = useCreationHost<ConceptCreateFact, ReturnType<typeof conceptCreateHolders>>({
    initial,
    locale,
    scope: 'concept-create',
    types: conceptCreateTypes,
    load: () => loadConceptCreate({ data: true }),
    failure: <p>{m.concept_create_unavailable({}, { locale: locale as never })}</p>,
    admit: (entry) => !handoff || classificationTargetAdmitted(entry.id, entry.bases ?? [], handoff.targets),
  });
  const {
    work,
    reading,
    currentRead,
    release,
    pending,
    factsByType,
    setFactsByType,
    prepared,
    retainedTypes,
    activeTypes,
    types,
    metadata,
    metadataRevision,
    activeTypeIds,
    refreshMetadata,
  } = host;

  const visitKey = JSON.stringify([token ?? '', work.reader, reading.ok ? reading.digest : 'unavailable']);
  const currentVisit = useRef({ key: visitKey, reading });
  currentVisit.current = { key: visitKey, reading };
  const restorationPending =
    !!token && !!work.reader && (restoration?.token !== token || restoration.reader !== work.reader);
  const restoredAcknowledgementId =
    token && !restorationPending && restoration?.token === token && restoration.reader === work.reader
      ? restoration.id
      : undefined;
  const currentHandoff =
    token && !restorationPending && handoff?.token === token && handoff.reader === work.reader ? handoff : undefined;
  const disclosedIdentity =
    disclosure?.visitKey === visitKey && disclosure.reader === work.reader ? disclosure.identity : undefined;

  useEffect(() => {
    if (!token) {
      setHandoff(undefined);
      setRestoration(undefined);
      setDisclosure(undefined);
      return;
    }
    returning.current = false;
    setHandoff(undefined);
    setDisclosure(undefined);
    setReturnReadFailure(undefined);
    if (!work.reader) {
      setRestoration({ token, reader: '' });
      return;
    }
    const current = readClassificationCreateHandoff(token);
    let matching = current?.reader === work.reader ? current : undefined;
    if (current && !matching) discardClassificationCreateHandoff(token);
    let id = readClassificationCreateAcknowledgement(token, work.reader);
    if (matching?.createdId && id && matching.createdId !== id) {
      discardClassificationCreateHandoff(token);
      matching = undefined;
    }
    if (!id && matching?.createdId) {
      id = matching.createdId;
      recordClassificationCreateAcknowledgement(token, work.reader, id);
    }
    if (
      matching &&
      (matching.phase === 'creating' || matching.phase === 'ready') &&
      (!matching.createdId || matching.createdId === id)
    )
      setHandoff(matching);
    else if (matching) discardClassificationCreateHandoff(token);
    setRestoration({ token, reader: work.reader, ...(id ? { id } : {}) });
  }, [token, work.reader]);

  function recordCreated(result: Created, expectedVisitKey: string) {
    if (currentVisit.current.key !== expectedVisitKey || !work.live() || !work.reader) return;
    const disclosed = createdIdentity(result, currentVisit.current.reading);
    setDisclosure(disclosed ? { visitKey: expectedVisitKey, reader: work.reader, identity: disclosed } : undefined);
    setReturnReadFailure(undefined);
    if (!token) return;
    setRestoration((current) =>
      current?.token === token && current.reader === work.reader
        ? { ...current, id: result.id }
        : { token, reader: work.reader, id: result.id },
    );
    const stored = readClassificationCreateHandoff(token);
    const current = stored?.reader === work.reader ? stored : currentHandoff;
    if (!current) return;
    const savedAcknowledgement = readClassificationCreateAcknowledgement(token, work.reader);
    if (savedAcknowledgement && savedAcknowledgement !== result.id) {
      discardClassificationCreateHandoff(current.token);
      setHandoff(undefined);
      return;
    }
    if (!savedAcknowledgement) recordClassificationCreateAcknowledgement(token, work.reader, result.id);
    if (current.phase !== 'creating' && current.phase !== 'ready') return;
    const next = recordCreatedClassificationIdentity(
      current.token,
      current.sourceId,
      current.reader,
      result.id,
      disclosed && classificationTargetAdmitted(disclosed.type, disclosed.bases, current.targets)
        ? disclosed
        : undefined,
    );
    if (!next) {
      setHandoff(undefined);
      return;
    }
    setHandoff(next);
  }

  function returnDraft() {
    const current = currentHandoff;
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
      eligibility: () => readCatalogueCreateEligibility(),
      submit: (command: { item: InitialSubject; key: string }) =>
        currentVisit.current.key === visitKey && work.live()
          ? createCatalogueConcept({
              data: editorRequest(command as ConceptCreateCommand, work),
              headers: csrfHeaders(),
            })
          : Promise.resolve({ ok: false as const, reason: 'unavailable' as const }),
      read: async (id: string) => {
        if (!work.live()) return { state: 'stale' as const };
        const reader = await readCreatedCatalogueSubject({ data: id });
        if (!work.live() || currentVisit.current.key !== visitKey) return { state: 'stale' as const };
        const current = currentVisit.current.reading;
        if (!current.ok || reader.state !== 'ready' || !reader.identity) return reader;
        return conceptAdmitCreatedReader(reader, id, current.release, reader.identity.type);
      },
    }),
    [visitKey, work],
  );

  async function returnWithIdentity() {
    const current = currentHandoff;
    const id = restoredAcknowledgementId ?? current?.createdId;
    if (!current || !id || current.reader !== work.reader || !work.live() || returning.current) return;
    const expectedVisitKey = visitKey;
    returning.current = true;
    setReturnPending(true);
    setReturnReadFailure(undefined);
    setDisclosure(undefined);
    let returned = false;
    try {
      const reader = await transport.read(id);
      if (currentVisit.current.key !== expectedVisitKey || !work.live()) return;
      if (reader.state !== 'ready' || !reader.identity) {
        setReturnReadFailure(reader.state);
        return;
      }
      const identity = createdIdentity({ ok: true, id, reader }, currentVisit.current.reading);
      if (!identity || !classificationTargetAdmitted(identity.type, identity.bases, current.targets)) {
        setReturnReadFailure('stale');
        return;
      }
      const next = recordCreatedClassificationIdentity(current.token, current.sourceId, current.reader, id, identity);
      if (!next || next.phase !== 'ready') {
        setReturnReadFailure('unavailable');
        setHandoff(undefined);
        return;
      }
      setHandoff(next);
      setDisclosure({ visitKey: expectedVisitKey, reader: work.reader, identity });
      if (!beginClassificationReturn(current.token, current.sourceId, work.reader)) {
        setReturnReadFailure('stale');
        return;
      }
      window.location.assign(classificationReturnHref(current.returnPath, current.token));
      returned = true;
    } catch {
      if (currentVisit.current.key === expectedVisitKey && work.live()) setReturnReadFailure('unavailable');
    } finally {
      if (currentVisit.current.key === expectedVisitKey && work.live()) {
        setReturnPending(false);
        if (!returned) returning.current = false;
      }
    }
  }

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
            releaseDigest: metadataRevision,
            initialLanguage: '',
            reviewRevision: host.reviewRevision,
            onTypeDraftChange: host.onTypeDraftChange,
            onDiscardType: host.onDiscardType,
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
                  onJump={host.jumpToField}
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

  const identityIntake = {
    viewerKey: JSON.stringify([state, subject ?? '', csrfToken ?? '']),
    viewerState: state as Session,
  };

  const createForm = (
    <CreateSubjectForm
      key={`${token ?? 'direct'}:${work.reader}`}
      locale={locale}
      session={state}
      transport={transport}
      onCreated={(result) => recordCreated(result, visitKey)}
      onNavigate={currentHandoff ? () => {} : (href) => window.location.assign(href)}
      identityIntake={identityIntake}
      {...(profile ? { profile } : {})}
      {...(restoredAcknowledgementId ? { restoredAcknowledgementId } : {})}
      recoveryOnly={!profile && !!restoredAcknowledgementId}
      {...(currentHandoff
        ? {
            typeAdmission: {
              offered: activeTypes,
              unavailable: currentHandoff.targets.filter(
                (target) =>
                  !activeTypes.some((entry) => classificationTargetAdmitted(entry.id, entry.bases ?? [], [target])),
              ),
              admitType: (type: CreateType) =>
                classificationTargetAdmitted(type.id, type.bases ?? [], currentHandoff.targets),
            },
          }
        : {})}
    />
  );

  if (!release || !profile) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.concept_create_title({}, o)}</PageHeading>
        {token && !currentHandoff && !restorationPending && (
          <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>
        )}
        {restorationPending && <p role="status">{m.catalogue_create_loading({}, o)}</p>}
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
        {restoredAcknowledgementId && createForm}
      </article>
    );
  }

  if (reading.ok && activeTypes.length === 0 && retainedTypes.size === 0 && !restoredAcknowledgementId) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.concept_create_title({}, o)}</PageHeading>
        {token && !currentHandoff && !restorationPending && (
          <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>
        )}
        <p>{m.concept_create_intro({}, o)}</p>
        <p role="status">{m.concept_create_absent({}, o)}</p>
      </article>
    );
  }

  return (
    <div className="space-y-6">
      {token && !currentHandoff && !restorationPending && (
        <p role="alert">{m.classification_create_handoff_invalid({}, o)}</p>
      )}
      {currentHandoff && (
        <section
          aria-labelledby={titleId}
          className="mx-auto max-w-3xl space-y-3 rounded-xl border border-border bg-muted/30 p-4"
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {m.classification_create_source({}, o)}
          </h2>
          <p>
            {m.classification_create_context(
              { relation: currentHandoff.propertyLabel, source: currentHandoff.sourceLabel },
              o,
            )}
          </p>
          <p className="text-sm text-muted-foreground">{m.classification_create_distinct({}, o)}</p>
        </section>
      )}
      {reading.ok && activeTypes.length === 0 && (
        <p role="status" className="mx-auto mb-4 max-w-3xl px-4">
          {m.concept_create_absent({}, o)}
        </p>
      )}
      {restorationPending ? (
        <p role="status" className="mx-auto max-w-3xl px-4">
          {m.catalogue_create_loading({}, o)}
        </p>
      ) : (
        createForm
      )}
      {disclosedIdentity && (
        <section className="mx-auto max-w-3xl space-y-3 rounded-xl border border-border bg-muted/30 p-4">
          <h2 className="text-lg font-semibold">{m.concept_create_reader_disclosure({}, o)}</h2>
          <dl className="space-y-2">
            <div>
              <dt className="font-medium">{m.concept_create_reader_label({}, o)}</dt>
              <dd>{disclosedIdentity.label}</dd>
            </div>
            <div>
              <dt className="font-medium">{m.concept_create_reader_type({}, o)}</dt>
              <dd className="break-all">{disclosedIdentity.type}</dd>
            </div>
            <div>
              <dt className="font-medium">{m.concept_create_reader_bases({}, o)}</dt>
              <dd className="break-all">
                {disclosedIdentity.bases.length ? disclosedIdentity.bases.join(', ') : m.concept_create_no_bases({}, o)}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {currentHandoff &&
        disclosedIdentity &&
        currentHandoff.phase === 'ready' &&
        currentHandoff.createdId === disclosedIdentity.id &&
        currentHandoff.identity?.id === disclosedIdentity.id && (
          <div className="mx-auto max-w-3xl px-4">
            <Button type="button" variant="outline" disabled={returnPending} onClick={() => void returnWithIdentity()}>
              {m.classification_create_return_to_draft({}, o)}
            </Button>
          </div>
        )}
      {currentHandoff && returnReadFailure && (
        <div role="alert" className="mx-auto max-w-3xl space-y-3 px-4">
          <p>
            {returnReadFailure === 'concealed'
              ? m.catalogue_create_concealed({}, o)
              : returnReadFailure === 'stale'
                ? m.catalogue_create_reader_stale({}, o)
                : returnReadFailure === 'denied'
                  ? m.catalogue_create_reader_denied({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
          </p>
          <Button type="button" variant="outline" disabled={returnPending} onClick={() => void returnWithIdentity()}>
            {m.catalogue_create_retry({}, o)}
          </Button>
        </div>
      )}
      {returnPending && (
        <p role="status" className="mx-auto max-w-3xl px-4">
          {m.catalogue_create_loading({}, o)}
        </p>
      )}
      {currentHandoff &&
        currentHandoff.phase === 'creating' &&
        !currentHandoff.createdId &&
        !restoredAcknowledgementId && (
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
