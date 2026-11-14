import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useRef, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../../paraglide/messages.js';
import type { AniListRow, AniListLabelSelection, AniListLabelTargetsResult, AniListRowMeta } from './contract';
import { AniListAction, AniListCheck } from './controls';
import { AniListTargetSearch } from './target';
import { ImportDetails } from '../personal-list-import/presentation';
import { AniListLabelResult } from './results';

/** One retained row, one bounded target-search page; native evidence is never reconstructed from JSON. */
export function AniListLabelAdoption({
  row,
  meta,
  busy,
  cancelled,
  current,
  onChoose,
  onReview,
  onConfirm,
  onRead,
  onSearch,
}: {
  row: AniListRow;
  meta: AniListRowMeta;
  busy: boolean;
  cancelled: boolean;
  current: () => boolean;
  onChoose: (subjectId: string | null, selections: AniListLabelSelection[]) => void;
  onReview: () => void;
  onConfirm: () => void;
  onRead: () => void;
  onSearch: (query: string, cursor?: string) => Promise<AniListLabelTargetsResult>;
}) {
  const id = useId();
  const headingId = `${id}-heading`;
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<Extract<AniListLabelTargetsResult, { kind: 'label-targets' }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [failedSearch, setFailedSearch] = useState<{ query: string; cursor?: string } | null>(null);
  const searchEpoch = useRef(0);
  const labels = meta.labels!;
  const searchContext = useRef({ row, subjectId: labels.subjectId });
  searchContext.current = { row, subjectId: labels.subjectId };
  const visitIsCurrent = current();
  useEffect(
    () => () => {
      searchEpoch.current += 1;
    },
    [],
  );
  useEffect(() => {
    searchEpoch.current += 1;
    setSearching(false);
    setSearchFailed(false);
    setFailedSearch(null);
  }, [row, labels.subjectId]);
  useEffect(() => {
    if (visitIsCurrent) return;
    searchEpoch.current += 1;
    setSearching(false);
    setSearchFailed(false);
    setFailedSearch(null);
  }, [visitIsCurrent]);
  const evidence = row.labelEvidence!;
  const selections = labels.selections;
  const reviewed = labels.review;
  const unfinished = Object.values(row.labelWork ?? {}).some(
    (work) =>
      (work.createStarted || work.assignStarted) &&
      (!work.outcome || work.outcome.status === 'pending' || work.outcome.status === 'failed'),
  );
  const locked = busy || cancelled || unfinished;
  function select(key: string, value: string, member: boolean) {
    onChoose(
      labels.subjectId,
      member ? [...selections, { key, target: { name: value } }] : selections.filter((item) => item.key !== key),
    );
  }
  function target(key: string, next: AniListLabelSelection['target']) {
    onChoose(
      labels.subjectId,
      selections.map((item) => (item.key === key ? { key, target: next } : item)),
    );
  }
  async function search(cursor?: string, requestedQuery = query) {
    if (!current()) return;
    const epoch = ++searchEpoch.current;
    const requestedRow = row;
    const requestedSubject = labels.subjectId;
    const isCurrentRequest = () =>
      epoch === searchEpoch.current &&
      current() &&
      searchContext.current.row === requestedRow &&
      searchContext.current.subjectId === requestedSubject;
    const request = { query: requestedQuery, ...(cursor === undefined ? {} : { cursor }) };
    setSearching(true);
    setSearchFailed(false);
    setFailedSearch(null);
    try {
      const response = await onSearch(requestedQuery, cursor);
      if (!isCurrentRequest()) return;
      if (response.kind === 'label-targets') {
        setTargets(response);
        setSearchFailed(false);
        setFailedSearch(null);
      } else {
        setSearchFailed(true);
        setFailedSearch(request);
      }
    } catch {
      if (!isCurrentRequest()) return;
      setSearchFailed(true);
      setFailedSearch(request);
    } finally {
      if (isCurrentRequest()) setSearching(false);
    }
  }
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-4 rounded-xl border bg-muted/20 p-4 [overflow-wrap:anywhere] sm:p-5"
      data-anilist-label-row={row.ordinal}
    >
      <header className="space-y-1">
        <h4 id={headingId} className="font-semibold">
          {m.library_import_labels()}
        </h4>
        <p>{m.library_anilist_labels_independent()}</p>
      </header>
      <ImportDetails>
        <dl className="space-y-1 text-sm" data-anilist-label-evidence>
          <dt>{m.library_anilist_labels_membership()}</dt>
          <dd>{evidence.membership}</dd>
          <dt>{m.library_anilist_group()}</dt>
          <dd>{evidence.grouping}</dd>
          <dt>{m.library_anilist_labels_tags()}</dt>
          <dd>
            {evidence.tagEvidence.entry} · {evidence.tagEvidence.media} · {evidence.tagEvidence.membership}
          </dd>
        </dl>
        <p className="text-sm">{evidence.reason}</p>
      </ImportDetails>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-4">
          <section className="min-w-0 space-y-2" data-anilist-label-subject>
            <h5 className="font-medium">{m.library_import_target()}</h5>
            <AniListTargetSearch
              disabled={locked}
              value={labels.subjectId}
              onChange={(subjectId) => onChoose(subjectId, selections)}
            />
          </section>
          <section className="min-w-0 space-y-2" data-anilist-label-target-search>
            <label htmlFor={`${id}-search`}>{m.library_anilist_labels_search()}</label>
            <input
              id={`${id}-search`}
              className="min-h-11 w-full rounded border px-3"
              disabled={locked}
              value={query}
              onChange={(event) => {
                searchEpoch.current++;
                setSearching(false);
                setSearchFailed(false);
                setFailedSearch(null);
                setQuery(event.target.value);
                setTargets(null);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <AniListAction type="button" variant="outline" disabled={locked || searching} onClick={() => void search()}>
                {m.library_anilist_labels_search()}
              </AniListAction>
              {searchFailed && failedSearch ? (
                <AniListAction
                  type="button"
                  variant="outline"
                  disabled={locked || searching}
                  onClick={() => void search(failedSearch.cursor, failedSearch.query)}
                >
                  {m.library_import_page_retry()}
                </AniListAction>
              ) : null}
              {targets?.next ? (
                <AniListAction
                  type="button"
                  variant="outline"
                  disabled={locked || searching}
                  onClick={() => void search(targets.next!)}
                >
                  {m.library_anilist_labels_more()}
                </AniListAction>
              ) : null}
            </div>
            {searchFailed ? <p role="status">{m.library_anilist_labels_search_failed()}</p> : null}
            {targets ? (
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-anilist-label-search-provenance>
                {m.library_anilist_labels_search()} · {query}
              </p>
            ) : null}
          </section>
        </div>
        <section className="min-w-0 space-y-3" data-anilist-label-selections>
          <h5 className="font-medium">{m.library_anilist_labels_mapping()}</h5>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
            {evidence.values.map((value) => {
              const selection = selections.find((item) => item.key === value.key);
              const targetLabelId = selection && 'labelId' in selection.target ? selection.target.labelId : null;
              const selectable = evidence.selectable.some((item) => item.key === value.key);
              const labelTargetOptions = [
                { value: 'new', label: m.library_anilist_labels_new() },
                ...(targetLabelId && !targets?.labels.some((item) => item.id === targetLabelId)
                  ? [{ value: targetLabelId, label: targetLabelId }]
                  : []),
                ...(targets?.labels ?? []).map((label) => ({
                  value: label.id,
                  label: `${label.name} · ${label.id}`,
                })),
              ];
              return (
                <li
                  key={value.key}
                  className="min-w-0 space-y-2 rounded-lg border bg-card p-3"
                  data-anilist-label-key={value.key}
                >
                  <p>{value.value}</p>
                  <ImportDetails>
                    <p>
                      {value.key} · {value.origin} · {String(value.member)}
                    </p>
                  </ImportDetails>
                  {selectable ? (
                    <>
                      <AniListCheck
                        id={`${id}-${value.key}`}
                        checked={!!selection}
                        disabled={locked || (!selection && selections.length >= 8)}
                        label={m.library_anilist_labels_select()}
                        onToggle={(checked) => select(value.key, value.value, checked)}
                      />
                      {selection ? (
                        <>
                          <Field>
                            <FieldLabel id={`${id}-${value.key}-target-label`} htmlFor={`${id}-${value.key}-target`}>
                              {m.library_anilist_labels_mapping()}
                            </FieldLabel>
                            <Select<string, false>
                              items={labelTargetOptions}
                              disabled={locked}
                              value={'name' in selection.target ? 'new' : selection.target.labelId}
                              onValueChange={(next) => {
                                if (next !== null)
                                  target(value.key, next === 'new' ? { name: value.value } : { labelId: next });
                              }}
                            >
                              <SelectTrigger
                                id={`${id}-${value.key}-target`}
                                aria-labelledby={`${id}-${value.key}-target-label`}
                                className="min-h-11 w-full rounded border px-3"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent alignItemWithTrigger={false}>
                                <SelectGroup>
                                  {labelTargetOptions.map(({ value, label, ...itemProps }) => (
                                    <SelectItem key={value ?? ''} value={value} {...itemProps}>
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          {'name' in selection.target ? (
                            <>
                              <label htmlFor={`${id}-${value.key}-name`}>{m.library_anilist_labels_new()}</label>
                              <input
                                id={`${id}-${value.key}-name`}
                                className="min-h-11 w-full rounded border px-3"
                                disabled={locked}
                                value={selection.target.name}
                                onChange={(event) => target(value.key, { name: event.target.value })}
                              />
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      <AniListAction type="button" disabled={locked || !labels.subjectId || selections.length === 0} onClick={onReview}>
        {m.library_anilist_labels_review()}
      </AniListAction>
      {reviewed ? (
        <section className="min-w-0 space-y-3 rounded-lg border bg-card p-4" data-anilist-label-review={reviewed.id}>
          <h4 className="font-medium">{m.library_anilist_labels_reviewed()}</h4>
          <p>
            {reviewed.subjectId} · {reviewed.id}
          </p>
          <ol className="space-y-2">
            {reviewed.items.map((item) => (
              <li key={item.key}>
                <p>
                  {item.key} · {item.value} · {item.origin}
                </p>
                <p>
                  {'label' in item.target
                    ? `${item.target.label.id} · ${item.target.label.revision}`
                    : item.target.name}
                </p>
              </li>
            ))}
          </ol>
          <p>{m.library_anilist_labels_collision()}</p>
          <AniListAction type="button" disabled={busy || labels.invalidated || cancelled} onClick={onConfirm}>
            {m.library_anilist_labels_confirm()}
          </AniListAction>
          <AniListAction type="button" variant="outline" disabled={busy} onClick={onRead}>
            {m.library_anilist_labels_read()}
          </AniListAction>
        </section>
      ) : null}
      <section className="min-w-0 space-y-3 border-t pt-4" data-anilist-label-result>
        <h5 className="font-medium">{m.library_import_results()}</h5>
        <AniListLabelResult row={row} labels={labels} />
      </section>
    </section>
  );
}
