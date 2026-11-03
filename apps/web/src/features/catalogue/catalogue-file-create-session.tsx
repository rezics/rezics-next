import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { Button } from '@rezics/ui/shadcn/button';
import { PageHeading } from '../../shell/page-heading';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import { m } from '../../paraglide/messages.js';
import { editorRequest } from './editor-request';
import { CreateSubjectForm } from './create-subject-form';
import { readCreatedCatalogueSubject } from './create-subject-actions';
import type { CreateType, InitialSubject } from './create-subject';
import { relationTargetSearch } from './relation-editor-search';
import { createCatalogueFileSubject, loadCatalogueFileCreate } from './catalogue-file-create-actions';
import {
  catalogueFileCreateControl,
  catalogueFileCreateDraft,
  catalogueFileCreateHolders,
  catalogueFileCreatePreparedFacts,
  catalogueFileCreateTypes,
  type CatalogueFileCreateFact,
  type CatalogueFileCreateCommand,
  type CatalogueFileCreateItem,
  type CatalogueFileCreateRead,
} from './catalogue-file-create';
import { isFileOrGroupType } from './catalogue-file-profile/model';
import { CatalogueFileCreateFields } from './catalogue-file-create-fields';
import { CatalogueFileCreateReview } from './catalogue-file-create-review';

type ReadyRead = Extract<CatalogueFileCreateRead, { ok: true }>;
type Metadata = { ready: boolean; pending: boolean; failure: ReactNode; types: CreateType[] };
const factsId = 'catalogue-file-initial-facts';
const formClass =
  'inline-flex min-h-11 min-w-11 items-center justify-center whitespace-normal rounded-md border px-4 py-2';

function CatalogueFileCreateSessionLive({ locale, initial }: { locale: string; initial: CatalogueFileCreateRead }) {
  const work = useCatalogueLifetime('catalogue-file-create');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  const [reading, setReading] = useState<CatalogueFileCreateRead>(initial);
  const lastGood = useRef<ReadyRead | undefined>(initial.ok ? initial : undefined);
  const [pending, setPending] = useState(false);
  const [termDrafts, setTermDrafts] = useState<Record<string, boolean>>({});
  const [factsByType, setFactsByType] = useState<Record<string, CatalogueFileCreateFact[]>>({});
  const [archived, setArchived] = useState<CreateType[]>([]);
  const refreshing = useRef(false);
  const prepared = useRef<
    | {
        release: Release;
        digest: string;
        holders: ReturnType<typeof catalogueFileCreateHolders>;
      }
    | undefined
  >(undefined);

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
  const activeTypes = reading.ok ? catalogueFileCreateTypes(reading.release, locale) : [];
  const currentIds = new Set(activeTypes.map((entry) => entry.id));
  const archivedTypes = archived.filter((entry) => retainedTypes.has(entry.id) && !currentIds.has(entry.id));
  const types = reading.ok
    ? [...activeTypes, ...archivedTypes]
    : currentRead
      ? catalogueFileCreateTypes(currentRead.release, locale)
      : [];
  const metadata: Metadata = {
    ready: reading.ok,
    pending,
    failure: <p>{m.catalogue_file_create_unavailable({}, { locale: locale as never })}</p>,
    types,
  };
  const metadataRevision = reading.ok ? reading.digest : (currentRead?.digest ?? 'unavailable');
  const activeTypeIds = new Set(activeTypes.map((entry) => entry.id));

  async function refreshMetadata() {
    if (!work.active() || refreshing.current) return;
    refreshing.current = true;
    setPending(true);
    try {
      const result = await loadCatalogueFileCreate({ data: true });
      if (!work.active()) return;
      if (result.ok) {
        const previous = lastGood.current;
        if (previous) {
          const admitted = new Set(catalogueFileCreateTypes(result.release, locale).map((entry) => entry.id));
          const previousTypes = catalogueFileCreateTypes(previous.release, locale).filter(
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

  const transport = useMemo(
    () => ({
      submit: (command: { item: InitialSubject; key: string }) =>
        createCatalogueFileSubject({
          data: editorRequest(command as CatalogueFileCreateCommand, work),
          headers: csrfHeaders(),
        }),
      read: (id: string) => readCreatedCatalogueSubject({ data: id }),
    }),
    [work],
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
      <CatalogueFileCreateFields
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
            title: m.catalogue_file_create_title({}, { locale: locale as never }),
            intro: m.catalogue_file_create_intro({}, { locale: locale as never }),
            href: `/${locale}/catalogue/file`,
            scope: 'catalogue-file-create',
            metadata,
            refreshMetadata,
            retainTypeDrafts: true,
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
              reading.ok && activeTypeIds.has(type) && isFileOrGroupType(reading.release, type),
            canCreateType: (type: string) => reading.ok && activeTypeIds.has(type),
            labelLanguage: (type: string) => pickText(release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type: string) =>
              pickText(release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            fields,
            prepare: (initial: InitialSubject) => {
              const facts = catalogueFileCreatePreparedFacts(factsByType[initial.type] ?? [], release);
              const result = catalogueFileCreateDraft(release, initial, facts);
              prepared.current = {
                release,
                digest: reading.ok ? reading.digest : metadataRevision,
                holders: catalogueFileCreateHolders(facts),
              };
              return result;
            },
            control: (pointer: string, type: string) => {
              const snapshot = prepared.current;
              if (!snapshot) return undefined;
              return catalogueFileCreateControl(
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
                <CatalogueFileCreateReview
                  item={state.item as CatalogueFileCreateItem}
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
    [activeTypeIds, factsByType, fields, locale, metadata, metadataRevision, reading, release, retainedTypes, search],
  );

  if (!release || !profile) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.catalogue_file_create_title({}, { locale: locale as never })}</PageHeading>
        {reading.ok ? (
          <p role="status">{m.catalogue_file_create_absent({}, { locale: locale as never })}</p>
        ) : (
          <div role="alert" className="space-y-3">
            <p>{m.catalogue_file_create_unavailable({}, { locale: locale as never })}</p>
            <Button
              type="button"
              variant="outline"
              className={formClass}
              disabled={pending}
              onClick={() => void refreshMetadata()}
            >
              {m.catalogue_create_retry({}, { locale: locale as never })}
            </Button>
          </div>
        )}
      </article>
    );
  }

  if (reading.ok && activeTypes.length === 0 && retainedTypes.size === 0) {
    return (
      <article className="mx-auto min-w-0 w-full max-w-3xl space-y-5 p-4">
        <PageHeading>{m.catalogue_file_create_title({}, { locale: locale as never })}</PageHeading>
        <p>{m.catalogue_file_create_intro({}, { locale: locale as never })}</p>
        <p role="status">{m.catalogue_file_create_absent({}, { locale: locale as never })}</p>
      </article>
    );
  }

  return (
    <>
      {reading.ok && activeTypes.length === 0 && (
        <p role="status" className="mx-auto mb-4 max-w-3xl px-4">
          {m.catalogue_file_create_absent({}, { locale: locale as never })}
        </p>
      )}
      <CreateSubjectForm
        locale={locale}
        session={state}
        transport={transport}
        onNavigate={(href) => window.location.assign(href)}
        profile={profile}
      />
    </>
  );
}

export const CatalogueFileCreateSession = candidateSession(CatalogueFileCreateSessionLive);
