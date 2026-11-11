import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useRef, useState } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../../paraglide/messages.js';
import type { AniListRow, AniListLabelSelection, AniListLabelTargetsResult, AniListRowMeta } from './contract';
import { AniListAction, AniListCheck } from './controls';
import { AniListTargetSearch } from './target';
import { aniListTitle } from './meaning';
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
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<Extract<AniListLabelTargetsResult, { kind: 'label-targets' }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchEpoch = useRef(0);
  const evidence = row.labelEvidence!;
  const labels = meta.labels!;
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
  async function search(cursor?: string) {
    const epoch = ++searchEpoch.current;
    setSearching(true);
    const response = await onSearch(query, cursor);
    if (!current() || epoch !== searchEpoch.current) return;
    setSearching(false);
    if (reviewed) onChoose(labels.subjectId, selections);
    setSearchFailed(response.kind !== 'label-targets');
    setTargets(response.kind === 'label-targets' ? response : null);
  }
  return (
    <article
      className="min-w-0 space-y-4 rounded-lg border p-4 [overflow-wrap:anywhere]"
      data-anilist-label-row={row.ordinal}
    >
      <h3 className="text-lg font-medium">
        {m.library_anilist_labels_title()} · {aniListTitle(row.source.evidence, m.library_anilist_untitled())}
      </h3>
      <p>{m.library_anilist_labels_independent()}</p>
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
      <AniListTargetSearch
        disabled={locked}
        value={labels.subjectId}
        onChange={(subjectId) => onChoose(subjectId, selections)}
      />
      <div className="space-y-2">
        <label htmlFor={`${id}-search`}>{m.library_anilist_labels_search()}</label>
        <input
          id={`${id}-search`}
          className="min-h-11 w-full rounded border px-3"
          disabled={locked}
          value={query}
          onChange={(event) => {
            searchEpoch.current++;
            setSearching(false);
            setQuery(event.target.value);
            setTargets(null);
          }}
        />
        <div className="flex flex-wrap gap-3">
          <AniListAction type="button" variant="outline" disabled={locked || searching} onClick={() => void search()}>
            {m.library_anilist_labels_search()}
          </AniListAction>
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
      </div>
      <ul className="space-y-3">
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
            <li key={value.key} className="space-y-2 rounded border p-3" data-anilist-label-key={value.key}>
              <p>{value.value}</p>
              <p className="text-sm">
                {value.key} · {value.origin} · {String(value.member)}
              </p>
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
      <AniListAction type="button" disabled={locked || !labels.subjectId || selections.length === 0} onClick={onReview}>
        {m.library_anilist_labels_review()}
      </AniListAction>
      {reviewed ? (
        <section className="space-y-3 rounded border p-3" data-anilist-label-review={reviewed.id}>
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
      <AniListLabelResult row={row} labels={labels} />
    </article>
  );
}
