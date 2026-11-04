import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
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
      return snapshot.visibility;
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
  const [visit, setVisit] = useState(() => ({ collectionId, source, isCurrent, generation: 0 }));
  if (!isCurrent()) return null;
  if (visit.collectionId !== collectionId || visit.source !== source || !visit.isCurrent()) {
    setVisit({ collectionId, source, isCurrent, generation: visit.generation + 1 });
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<ReadState<CollectionMetadataHistoryPage>>({ state: 'loading' });
  const [selected, setSelected] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ReadState<CollectionMetadataHistoryChange[]>>({ state: 'loading' });
  const generation = useRef(0);
  const basis = useRef<CollectionMetadataHistoryPage['basis'] | null>(null);

  function retireResults() {
    generation.current++;
    basis.current = null;
    setPage({ state: 'loading' });
    setSelected([]);
    setComparison({ state: 'loading' });
  }

  function readPage(nextCursor: string | null) {
    if (!isCurrent()) return;
    retireResults();
    setCursor(nextCursor);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    retireResults();
    const operation = generation.current;
    void source
      .readPage({ collectionId, cursor, limit: 25 })
      .then((result) => {
        if (operation !== generation.current || !isCurrent()) return;
        if (result.state === 'available' && currentPage(result.value, collectionId)) {
          basis.current = result.value.basis;
          setPage({ state: 'available', value: result.value });
        } else setPage({ state: 'unavailable' });
      })
      .catch(() => {
        if (operation === generation.current && isCurrent()) setPage({ state: 'unavailable' });
      });
    return () => {
      generation.current++;
      basis.current = null;
    };
  }, [attempt, collectionId, cursor, source]);

  async function compareSelected() {
    const reviewedBasis = basis.current;
    if (!isCurrent() || selected.length !== 2 || reviewedBasis === null) return;
    const operation = ++generation.current;
    const revisions = [...selected];
    setComparison({ state: 'loading' });
    try {
      const results = await Promise.all(revisions.map((revision) => source.readChange({ collectionId, revision })));
      if (operation !== generation.current || !isCurrent()) return;
      if (
        results.some(
          (result, index) =>
            result.state !== 'available' ||
            !currentChange(result.value, collectionId, revisions[index]!) ||
            !sameBasis(result.value.basis, reviewedBasis),
        ) ||
        !basis.current ||
        !sameBasis(basis.current, reviewedBasis)
      ) {
        setComparison({ state: 'unavailable' });
        return;
      }
      setComparison({
        state: 'available',
        value: results.flatMap((result) => (result.state === 'available' ? [result.value] : [])),
      });
    } catch {
      if (operation === generation.current && isCurrent()) setComparison({ state: 'unavailable' });
    }
  }

  const selectedDetails = comparison.state === 'available' ? comparison.value : [];
  const fields = [...new Set(selectedDetails.flatMap((change) => change.changedFields))];

  return (
    <details id="collection-metadata-history" className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.library_collection_metadata_history()}</summary>
      <div className="space-y-4 pt-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{m.library_collection_metadata_history_description()}</p>
        {page.state === 'loading' ? <p role="status">{m.library_collection_metadata_history_loading()}</p> : null}
        {page.state === 'unavailable' ? (
          <div role="alert" className="space-y-2">
            <p>{m.library_collection_metadata_history_unavailable()}</p>
            <Button type="button" variant="outline" onClick={() => readPage(cursor)}>
              {m.library_collection_move_retry()}
            </Button>
            {cursor !== null ? (
              <Button type="button" variant="outline" onClick={() => readPage(null)}>
                {m.library_collection_metadata_history_first_page()}
              </Button>
            ) : null}
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
                      <label className="flex min-h-11 items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4"
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
                            setComparison({ state: 'loading' });
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
                disabled={selected.length !== 2}
                onClick={() => void compareSelected()}
              >
                {m.library_collection_metadata_history_compare()}
              </Button>
              {cursor !== null ? (
                <Button type="button" variant="outline" onClick={() => readPage(null)}>
                  {m.library_collection_metadata_history_first_page()}
                </Button>
              ) : null}
              {page.value.next ? (
                <Button type="button" variant="outline" onClick={() => readPage(page.value.next)}>
                  {m.library_collection_metadata_history_next_page()}
                </Button>
              ) : null}
              <a
                className="inline-flex min-h-11 items-center rounded-lg px-3 underline underline-offset-4"
                href="#collection-edit-form"
              >
                {m.library_collection_metadata_history_return_editor()}
              </a>
            </div>
            {comparison.state === 'loading' && selected.length === 2 ? (
              <p role="status">{m.library_collection_metadata_history_loading()}</p>
            ) : null}
            {comparison.state === 'unavailable' ? (
              <p role="alert">{m.library_collection_metadata_history_unavailable()}</p>
            ) : null}
            {selectedDetails.length === 2 ? (
              <div className="overflow-x-auto rounded-xl border border-border">
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
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
