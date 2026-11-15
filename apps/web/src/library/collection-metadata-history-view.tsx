import { cn } from '@rezics/ui/utils';
import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { readCollectionMetadataHistoryChange, readCollectionMetadataHistoryPage } from './collection-commands';
import type {
  CollectionMetadataHistoryChange,
  CollectionMetadataHistoryField,
  CollectionMetadataHistoryPage,
  CollectionMetadataHistorySource,
  CollectionMetadataHistorySnapshot,
} from './collection-metadata-history';

type Props = { collectionId: string; isCurrent: () => boolean; source?: CollectionMetadataHistorySource };
type ReadState<T> = { state: 'loading' } | { state: 'unavailable' } | { state: 'available'; value: T };
type ComparisonRequest = Readonly<{
  revisions: readonly [number, number];
  page: CollectionMetadataHistoryPage;
  basis: CollectionMetadataHistoryPage['basis'];
  generation: number;
}>;
type ComparisonState =
  | { state: 'idle' }
  | { state: 'loading'; request: ComparisonRequest }
  | { state: 'unavailable'; request: ComparisonRequest; retryable: boolean }
  | { state: 'available'; request: ComparisonRequest; value: CollectionMetadataHistoryChange[] };

function originatingVisit(
  collectionId: string,
  source: CollectionMetadataHistorySource,
  admission: () => boolean,
  generation: number,
) {
  const locale = getLocale();
  let retired = false;
  return {
    collectionId,
    source,
    generation,
    isCurrent: () => {
      // Retirement is permanent even when the same locale or apparently equal authority returns.
      if (!admission() || getLocale() !== locale) retired = true;
      return !retired;
    },
  };
}

const defaultSource: CollectionMetadataHistorySource = {
  readPage: (input) => readCollectionMetadataHistoryPage({ data: input }),
  readChange: (input) => readCollectionMetadataHistoryChange({ data: input }),
};

function fieldLabel(field: CollectionMetadataHistoryField): string {
  switch (field) {
    case 'title':
      return m.library_collection_title();
    case 'description':
      return m.library_collection_description();
    case 'visibility':
      return m.library_collection_visibility();
    case 'presentationKind':
      return m.library_collection_kind();
    case 'coverMediaId':
      return m.subject_cover();
  }
}

function value(snapshot: CollectionMetadataHistorySnapshot, field: CollectionMetadataHistoryField) {
  switch (field) {
    case 'title':
      return snapshot.title || m.library_collection_metadata_history_empty_value();
    case 'description':
      return snapshot.description ?? m.library_collection_metadata_history_empty_value();
    case 'visibility':
      switch (snapshot.visibility) {
        case 'private':
          return m.library_collection_visibility_private();
        case 'unlisted':
          return m.library_collection_visibility_unlisted();
        case 'public':
          return m.library_collection_visibility_public();
      }
    case 'presentationKind':
      return snapshot.presentationKind ?? m.library_collection_metadata_history_empty_value();
    case 'coverMediaId':
      return snapshot.cover.state === 'available'
        ? snapshot.cover.mediaId
        : snapshot.cover.state === 'none'
          ? m.library_collection_metadata_history_cover_none()
          : m.library_collection_metadata_history_cover_unavailable();
  }
}

function coverageText(page: CollectionMetadataHistoryPage): string {
  if (page.coverage.coverage === 'complete') return m.library_collection_metadata_history_complete();
  if (page.coverage.coverage === 'partial')
    return m.library_collection_metadata_history_partial({ revision: page.coverage.prunedBeforeRevision ?? 1 });
  return m.library_collection_metadata_history_unknown();
}

function currentPage(value: CollectionMetadataHistoryPage, collectionId: string): boolean {
  return (
    value.collectionId === collectionId &&
    value.basis.curatorAccountId === value.basis.viewerAccountId &&
    Number.isSafeInteger(value.basis.collectionRevision) &&
    value.actions.review === true &&
    value.actions.reapply === false
  );
}

function currentChange(value: CollectionMetadataHistoryChange, collectionId: string, revision: number): boolean {
  return (
    value.collectionId === collectionId &&
    value.revision === revision &&
    value.basis.curatorAccountId === value.basis.viewerAccountId &&
    Number.isSafeInteger(value.basis.collectionRevision) &&
    value.actions.review === true &&
    value.actions.reapply === false
  );
}

function sameBasis(
  left: CollectionMetadataHistoryChange['basis'],
  right: CollectionMetadataHistoryChange['basis'],
): boolean {
  return (
    left.collectionRevision === right.collectionRevision &&
    left.curatorAccountId === right.curatorAccountId &&
    left.viewerAccountId === right.viewerAccountId &&
    left.authnEpoch === right.authnEpoch &&
    left.minimumAuthnEpoch === right.minimumAuthnEpoch
  );
}

export function CollectionMetadataHistory({ collectionId, isCurrent, source = defaultSource }: Props) {
  // Keep the captured admission callback: replacing it with a fresh callback could revive private results.
  const [visit, setVisit] = useState(() => originatingVisit(collectionId, source, isCurrent, 0));
  if (!isCurrent()) return null;
  if (visit.collectionId !== collectionId || visit.source !== source || !visit.isCurrent()) {
    setVisit(originatingVisit(collectionId, source, isCurrent, visit.generation + 1));
    return null;
  }
  return (
    <MetadataHistoryVisit
      key={visit.generation}
      collectionId={collectionId}
      source={source}
      isCurrent={visit.isCurrent}
    />
  );
}

function MetadataHistoryVisit({ collectionId, isCurrent, source = defaultSource }: Props) {
  const [hasOpened, setHasOpened] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<ReadState<CollectionMetadataHistoryPage>>({ state: 'loading' });
  const [selected, setSelected] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ComparisonState>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<object | null>(null);
  const mounted = useRef(false);
  const observedPage = useRef<CollectionMetadataHistoryPage | null>(null);
  const generation = useRef(0);
  const basis = useRef<CollectionMetadataHistoryPage['basis'] | null>(null);

  function retireResults() {
    generation.current++;
    basis.current = null;
    observedPage.current = null;
    setPage({ state: 'loading' });
    setSelected([]);
    setComparison({ state: 'idle' });
  }

  function readPage(nextCursor: string | null) {
    if (!isCurrent()) return;
    retireResults();
    setCursor(nextCursor);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    if (!hasOpened) return;
    mounted.current = true;
    retireResults();
    const operation = generation.current;
    void source
      .readPage({ collectionId, cursor, limit: 25 })
      .then((result) => {
        if (operation !== generation.current || !isCurrent()) return;
        if (result.state === 'available' && currentPage(result.value, collectionId)) {
          observedPage.current = result.value;
          basis.current = result.value.basis;
          setPage({ state: 'available', value: result.value });
        } else setPage({ state: 'unavailable' });
      })
      .catch(() => {
        if (operation === generation.current && isCurrent()) setPage({ state: 'unavailable' });
      });
    return () => {
      mounted.current = false;
      generation.current++;
      basis.current = null;
      observedPage.current = null;
    };
  }, [attempt, collectionId, cursor, hasOpened, source]);

  function currentComparison(request: ComparisonRequest): boolean {
    return (
      mounted.current &&
      isCurrent() &&
      request.generation === generation.current &&
      observedPage.current === request.page &&
      basis.current !== null &&
      sameBasis(basis.current, request.basis)
    );
  }

  async function compare(request: ComparisonRequest) {
    // This lock belongs to the visit, not the selection or the displayed request state.
    // Retiring a selection must not admit another pair while either original read is pending.
    if (inFlight.current !== null || !currentComparison(request)) return;
    const token = {};
    inFlight.current = token;
    setBusy(true);
    setComparison({ state: 'loading', request });
    try {
      const results = await Promise.allSettled(
        request.revisions.map(async (revision) => source.readChange({ collectionId, revision })),
      );
      if (!currentComparison(request)) return;
      const changes: CollectionMetadataHistoryChange[] = [];
      let unavailable = false;
      let invalid = false;
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected' || result.value.state === 'unavailable') {
          unavailable = true;
        } else if (
          !currentChange(result.value.value, collectionId, request.revisions[index]!) ||
          !sameBasis(result.value.value.basis, request.basis)
        ) {
          invalid = true;
        } else changes.push(result.value.value);
      }
      if (unavailable || invalid) {
        // A disclosed response with a retired revision or basis cannot authorize recovery.
        setComparison({ state: 'unavailable', request, retryable: !invalid });
      } else setComparison({ state: 'available', request, value: changes });
    } finally {
      // Wait for both reads, including after a rejection; only this request can release its token.
      if (inFlight.current === token) {
        inFlight.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  function compareSelected() {
    const reviewedPage = observedPage.current;
    const reviewedBasis = basis.current;
    if (!isCurrent() || inFlight.current !== null || selected.length !== 2 || !reviewedPage || !reviewedBasis) return;
    const [first, second] = selected;
    if (
      first === undefined ||
      second === undefined ||
      first === second ||
      ![first, second].every(
        (revision) =>
          Number.isSafeInteger(revision) &&
          revision >= 2 &&
          reviewedPage.items.some((item) => item.revision === revision),
      )
    )
      return;
    void compare({
      revisions: [first, second],
      page: reviewedPage,
      basis: { ...reviewedBasis },
      generation: ++generation.current,
    });
  }

  if (!isCurrent()) return null;
  const selectedDetails =
    comparison.state === 'available' && currentComparison(comparison.request) ? comparison.value : [];
  const fields = [...new Set(selectedDetails.flatMap((change) => change.changedFields))];

  return (
    <details
      id="collection-metadata-history"
      className="rounded-2xl border border-border bg-card p-4 sm:p-6"
      onToggle={(event) => {
        if (event.currentTarget.open && isCurrent()) setHasOpened(true);
      }}
    >
      <summary className="cursor-pointer font-medium">{m.library_collection_metadata_history()}</summary>
      <div className="space-y-4 pt-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{m.library_collection_metadata_history_description()}</p>
        {cursor !== null ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-7 whitespace-normal break-words"
            onClick={() => readPage(null)}
          >
            {m.library_collection_metadata_history_first_page()}
          </Button>
        ) : null}
        {page.state === 'loading' ? <p role="status">{m.library_collection_metadata_history_loading()}</p> : null}
        {page.state === 'unavailable' ? (
          <div role="alert" className="space-y-2">
            <p>{m.library_collection_metadata_history_unavailable()}</p>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-7 whitespace-normal break-words"
              onClick={() => readPage(cursor)}
            >
              {m.library_collection_move_retry()}
            </Button>
          </div>
        ) : null}
        {page.state === 'available' ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              {coverageText(page.value)}
            </p>
            {page.value.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.library_collection_metadata_history_empty()}</p>
            ) : (
              <ul className="space-y-2" aria-label={m.library_collection_metadata_history()}>
                {page.value.items.map((item) => {
                  const checked = selected.includes(item.revision);
                  return (
                    <li key={item.revision} className="rounded-xl border border-border p-3">
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                          checked={checked}
                          disabled={!checked && selected.length >= 2}
                          aria-label={m.library_collection_metadata_history_select({ revision: item.revision })}
                          onChange={(event) => {
                            if (!isCurrent()) return;
                            generation.current++;
                            setSelected((previous) =>
                              event.target.checked
                                ? [...previous, item.revision].slice(-2)
                                : previous.filter((revision) => revision !== item.revision),
                            );
                            setComparison({ state: 'idle' });
                          }}
                        />
                        <span className="grid gap-1">
                          <strong>{m.library_collection_metadata_history_revision({ revision: item.revision })}</strong>
                          <time dateTime={item.recordedAt} className="break-all text-sm text-muted-foreground">
                            {item.recordedAt}
                          </time>
                          <span className="text-sm">{item.changedFields.map(fieldLabel).join(', ')}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-7 whitespace-normal break-words"
                disabled={selected.length !== 2 || busy}
                onClick={compareSelected}
              >
                {m.library_collection_metadata_history_compare()}
              </Button>
              {page.value.next ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-7 whitespace-normal break-words"
                  onClick={() => readPage(page.value.next)}
                >
                  {m.library_collection_metadata_history_next_page()}
                </Button>
              ) : null}
              <a
                className={cn(buttonVariants({ variant: 'link' }), 'h-auto min-h-7 max-w-full whitespace-normal')}
                href="#collection-edit-form"
                onClick={(event) => {
                  if (!isCurrent()) {
                    event.preventDefault();
                    return;
                  }
                  const title = document.getElementById('collection-edit-title');
                  const details = title?.closest('details');
                  if (details) details.open = true;
                  title?.focus({ preventScroll: true });
                }}
              >
                {m.library_collection_metadata_history_return_editor()}
              </a>
            </div>
            {comparison.state === 'idle' ? (
              <p role="status">
                {selected.length === 2
                  ? m.library_collection_metadata_history_ready()
                  : m.library_collection_metadata_history_selected({ count: selected.length })}
              </p>
            ) : null}
            {comparison.state === 'loading' ? (
              <p role="status">{m.library_collection_metadata_history_comparing()}</p>
            ) : null}
            {comparison.state === 'unavailable' ? (
              <div role="alert" className="space-y-2">
                <p>{m.library_collection_metadata_history_comparison_unavailable()}</p>
                {comparison.retryable && currentComparison(comparison.request) ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-7 whitespace-normal break-words"
                    disabled={busy}
                    onClick={() => void compare(comparison.request)}
                  >
                    {m.library_collection_metadata_history_retry_comparison()}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {comparison.state === 'available' ? (
              <p role="status">{m.library_collection_metadata_history_compared()}</p>
            ) : null}
            {selectedDetails.length === 2 ? (
              <>
                <div className="space-y-3 lg:hidden">
                  {fields.map((field) => (
                    <article key={field} className="rounded-xl border border-border p-3">
                      <h3 className="mb-3 font-semibold">{fieldLabel(field)}</h3>
                      <div className="space-y-3">
                        {selectedDetails.map((change) => (
                          <section key={change.revision} className="rounded-lg bg-muted/40 p-3">
                            <h4 className="mb-2 font-medium">
                              {m.library_collection_metadata_history_revision({ revision: change.revision })}
                            </h4>
                            <dl className="grid grid-cols-2 gap-3 text-sm">
                              <div className="min-w-0">
                                <dt className="mb-1 text-muted-foreground">
                                  {m.library_collection_metadata_history_before()}
                                </dt>
                                <dd className="whitespace-pre-wrap break-words">
                                  {value(change.before, field)}
                                </dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="mb-1 text-muted-foreground">
                                  {m.library_collection_metadata_history_after()}
                                </dt>
                                <dd className="whitespace-pre-wrap break-words">
                                  {value(change.after, field)}
                                </dd>
                              </div>
                            </dl>
                          </section>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
                  <table className="min-w-[48rem] w-full border-collapse text-start text-sm">
                    <thead>
                      <tr className="bg-muted/50">
                        <th scope="col" className="p-3">
                          {m.library_collection_metadata_history_field()}
                        </th>
                        {selectedDetails.map((change) => (
                          <th scope="col" colSpan={2} key={change.revision} className="p-3">
                            {m.library_collection_metadata_history_revision({ revision: change.revision })}
                          </th>
                        ))}
                      </tr>
                      <tr>
                        <th scope="col" className="p-3" />
                        {selectedDetails.flatMap((change) => [
                          <th scope="col" key={`${change.revision}-before`} className="p-3">
                            {m.library_collection_metadata_history_before()}
                          </th>,
                          <th scope="col" key={`${change.revision}-after`} className="p-3">
                            {m.library_collection_metadata_history_after()}
                          </th>,
                        ])}
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((field) => (
                        <tr key={field} className="border-t border-border align-top">
                          <th scope="row" className="p-3">
                            {fieldLabel(field)}
                          </th>
                          {selectedDetails.flatMap((change) => [
                            <td
                              key={`${change.revision}-${field}-before`}
                              className="max-w-64 whitespace-pre-wrap break-words p-3"
                            >
                              {value(change.before, field)}
                            </td>,
                            <td
                              key={`${change.revision}-${field}-after`}
                              className="max-w-64 whitespace-pre-wrap break-words p-3"
                            >
                              {value(change.after, field)}
                            </td>,
                          ])}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
