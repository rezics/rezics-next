import { useId } from 'react';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { PartValue } from './statement-editor-view';
import {
  completeReferenceGroup,
  previewReuse,
  reuseIsStale,
  reuseTargetLimit,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { factHolder, type FactDraft, type FactsCurrent } from './subject-facts';

const wrap = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2';

function refusalText(reason: ReuseRefusal, locale: string) {
  const o = { locale: locale as never };
  return reason === 'locked'
    ? m.facts_reuse_reason_locked({}, o)
    : reason === 'limit'
      ? m.facts_reuse_reason_limit({}, o)
      : reason === 'definition'
        ? m.facts_reuse_reason_definition({}, o)
        : reason === 'constraint'
          ? m.facts_reuse_reason_constraint({}, o)
          : reason === 'missing'
            ? m.facts_reuse_reason_missing({}, o)
            : m.facts_reuse_reason_source({}, o);
}

export function ReferenceReusePanel({
  source,
  drafts,
  selected,
  read,
  locale,
  capture,
  applied,
  refused,
  onSelected,
  onApply,
  onCancel,
  onRefresh,
  onOpen,
}: {
  source: ReuseSource;
  drafts: FactDraft[];
  selected: readonly string[];
  read: FactsCurrent;
  locale: string;
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
  onSelected: (holders: string[]) => void;
  onApply: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  onOpen: (holder: string, index: number) => void;
}) {
  const o = { locale: locale as never };
  const titleId = useId();
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  const live = origin?.statement.references[source.groupIndex];
  const present = completeReferenceGroup(live) && completeReferenceGroup(source.snapshot);
  const stale = reuseIsStale(source, drafts, selected, capture);
  const sourceLabel =
    pageText(read.release.properties[source.property]?.labels, locale).text || m.subject_value_unlabelled({}, o);
  const targets = drafts.filter((draft) => factHolder(draft) !== source.holder);
  return (
    <section
      data-fact-reuse
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-xl bg-card p-4 sm:p-5"
    >
      <ContentItemHeading id={titleId} level={2} className="text-lg font-semibold">
        {m.facts_reuse_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.facts_reuse_intro({}, o)}</p>
      <p className="text-sm">{m.facts_reuse_source({ field: sourceLabel }, o)}</p>
      {!present ? (
        <p role="status">{live && !live.parts.length ? m.facts_reuse_empty({}, o) : m.facts_reuse_missing({}, o)}</p>
      ) : (
        <ol className="min-w-0 space-y-2 border-s-2 border-border ps-3 text-sm">
          {source.snapshot.parts.map((part, index) => (
            <li key={index} className="min-w-0">
              <PartValue part={part} read={read} locale={locale} />
            </li>
          ))}
        </ol>
      )}
      <fieldset className="min-w-0 space-y-3" disabled={!present}>
        <legend className="text-sm font-medium">{m.facts_reuse_targets({ limit: reuseTargetLimit }, o)}</legend>
        {targets.map((draft) => {
          const holder = factHolder(draft);
          const preview = present
            ? previewReuse(draft, source.snapshot, read.release, source.holder)
            : { ok: false as const, reason: 'source' as const };
          const label = pageText(read.release.properties[draft.property]?.labels, locale).text || draft.property;
          const checked = selected.includes(holder);
          const id = `${titleId}-${holder}`;
          return (
            <div key={holder} className="min-w-0 space-y-1">
              <Field orientation="horizontal" className="min-w-0">
                <Checkbox
                  id={id}
                  className="size-11 after:inset-0"
                  checked={checked}
                  disabled={!preview.ok || (!checked && selected.length >= reuseTargetLimit)}
                  onCheckedChange={(value) => {
                    const next = value === true ? [...selected, holder] : selected.filter((item) => item !== holder);
                    onSelected(next.slice(0, reuseTargetLimit));
                  }}
                />
                <FieldLabel
                  className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]"
                  htmlFor={id}
                >
                  {label}
                </FieldLabel>
              </Field>
              <p className="text-sm text-muted-foreground">
                {preview.ok ? m.facts_reuse_preview_add({}, o) : refusalText(preview.reason, locale)}
              </p>
            </div>
          );
        })}
      </fieldset>
      {!!selected.length && present && (
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-semibold">{m.facts_reuse_preview({}, o)}</h3>
          <ul className="list-disc space-y-1 ps-5 text-sm">
            {selected.map((holder) => {
              const draft = drafts.find((item) => factHolder(item) === holder);
              const label = draft
                ? pageText(read.release.properties[draft.property]?.labels, locale).text || draft.property
                : holder;
              return (
                <li key={holder}>
                  {label}: {draft ? m.facts_reuse_preview_add({}, o) : m.facts_reuse_reason_missing({}, o)}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {stale && (
        <p role="status" className="text-sm">
          {m.facts_reuse_stale({}, o)}
        </p>
      )}
      {!!applied.length && (
        <p role="status">{m.facts_reuse_applied({ count: applied.length }, o)}</p>
      )}
      {refused.map((item) => (
        <p key={`${item.holder}:${item.reason}`} role="status" className="text-sm">
          {m.facts_reuse_refused(
            {
              field: pageText(read.release.properties[item.property]?.labels, locale).text || item.property,
              reason: refusalText(item.reason, locale),
            },
            o,
          )}
        </p>
      ))}
      {applied.map((item) => (
        <Button
          key={item.holder}
          type="button"
          variant="outline"
          className={wrap}
          onClick={() => onOpen(item.holder, item.index)}
        >
          {m.facts_reuse_open_copy({}, o)}
        </Button>
      ))}
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button type="button" variant="outline" className={wrap} onClick={onCancel}>
          {m.candidate_cancel({}, o)}
        </Button>
        {stale && (
          <Button type="button" variant="outline" className={wrap} onClick={onRefresh}>
            {m.facts_review({}, o)}
          </Button>
        )}
        <Button type="button" className={wrap} disabled={!present || stale || !selected.length} onClick={onApply}>
          {m.facts_reuse_apply({}, o)}
        </Button>
      </div>
    </section>
  );
}
