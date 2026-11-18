import { useId } from 'react';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { PartValue } from './statement-editor-view';
import type { StatementFieldsRead } from './statement-editor-view';
import type { Release } from '@rezics/definitions';
import {
  completeReferenceGroup,
  previewReuse,
  reuseIsStale,
  reuseTargetLimit,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { factHolder, type FactDraft } from './subject-facts';

const wrap = 'h-auto min-h-7 max-w-full whitespace-normal break-words';

function refusalText(reason: ReuseRefusal, locale: string) {
  const o = { locale: locale as never };
  return reason === 'locked'
    ? m.facts_reuse_reason_locked({}, o)
    : reason === 'unknown'
      ? m.facts_reuse_reason_unknown({}, o)
      : reason === 'withdrawn'
        ? m.facts_reuse_reason_withdrawn({}, o)
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
  read: {
    release: Pick<Release, 'properties' | 'types'>;
    public: Pick<StatementFieldsRead['public'], 'related'>;
  };
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
  const assertionView = (draft: FactDraft, prefix: string, fallbackLabel = draft.property) => {
    const sameProperty = drafts.filter((item) => item.property === draft.property);
    const occurrenceIndex = sameProperty.findIndex((item) => factHolder(item) === factHolder(draft)) + 1;
    const propertyLabel = pageText(read.release.properties[draft.property]?.labels, locale).text || fallbackLabel;
    const propertyId = `${prefix}-property`;
    const occurrenceId = sameProperty.length > 1 ? `${prefix}-occurrence` : undefined;
    const valueId = `${prefix}-value`;
    const qualifiers = draft.statement.qualifiers ?? [];
    const qualifierIds = qualifiers.map((_, index) => `${prefix}-qualifier-${index}`);
    const heading = (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]">
        <span id={propertyId} className="font-medium">
          {propertyLabel}
        </span>
        {occurrenceId && (
          <span id={occurrenceId} className="text-sm text-muted-foreground">
            {occurrenceIndex}/{sameProperty.length}
          </span>
        )}
      </div>
    );
    const details = (
      <div className="min-w-0 space-y-1 text-sm [overflow-wrap:anywhere]">
        <div id={valueId} className="min-w-0">
          <PartValue part={draft.statement} read={read} locale={locale} />
        </div>
        {qualifiers.length > 0 && (
          <ul className="min-w-0 space-y-1">
            {qualifiers.map((part, index) => (
              <li
                id={qualifierIds[index]}
                key={index}
                className="grid min-w-0 gap-x-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
              >
                <span className="min-w-0 text-sm text-muted-foreground">
                  {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
                    m.subject_value_unlabelled({}, o)}
                  :
                </span>
                <div className="min-w-0">
                  <PartValue part={part} read={read} locale={locale} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
    return {
      propertyLabel,
      propertyId,
      occurrenceId,
      occurrenceIndex,
      occurrenceCount: sameProperty.length,
      valueId,
      qualifierIds,
      labelIds: [propertyId, ...(occurrenceId ? [occurrenceId] : []), valueId, ...qualifierIds],
      heading,
      details,
      content: (
        <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
          {heading}
          {details}
        </div>
      ),
    };
  };
  const sourceAssertion = origin ? assertionView(origin, `${titleId}-source-${source.holder}`, sourceLabel) : undefined;
  return (
    <section data-fact-reuse aria-labelledby={titleId} className="min-w-0 space-y-4 rounded-xl bg-card p-4 sm:p-5">
      <ContentItemHeading id={titleId} level={2} className="text-lg font-semibold">
        {m.facts_reuse_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.facts_reuse_intro({}, o)}</p>
      <div className="min-w-0 space-y-1 text-sm">
        <p>
          {m.facts_reuse_source({ field: sourceLabel }, o)}
          {sourceAssertion?.occurrenceId && (
            <span id={sourceAssertion.occurrenceId} className="text-muted-foreground">
              {' '}
              {sourceAssertion.occurrenceIndex}/{sourceAssertion.occurrenceCount}
            </span>
          )}
        </p>
        {sourceAssertion?.details}
      </div>
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
          const context = assertionView(draft, `${titleId}-target-${holder}`);
          const previewId = `${titleId}-target-${holder}-outcome`;
          const checked = selected.includes(holder);
          const id = `${titleId}-${holder}`;
          return (
            <div key={holder} className="min-w-0 space-y-1">
              <Field orientation="horizontal" className="min-w-0">
                <Checkbox
                  id={id}

                  checked={checked}
                  disabled={!preview.ok || (!checked && selected.length >= reuseTargetLimit)}
                  onCheckedChange={(value) => {
                    const next = value === true ? [...selected, holder] : selected.filter((item) => item !== holder);
                    onSelected(next.slice(0, reuseTargetLimit));
                  }}
                  aria-labelledby={context.labelIds.join(' ')}
                  aria-describedby={previewId}
                />
                <FieldLabel
                  id={context.propertyId}
                  className="min-w-0 items-center gap-x-2 whitespace-normal [overflow-wrap:anywhere]"
                  htmlFor={id}
                >
                  {context.propertyLabel}
                  {context.occurrenceId && (
                    <span id={context.occurrenceId} className="text-sm text-muted-foreground">
                      {context.occurrenceIndex}/{context.occurrenceCount}
                    </span>
                  )}
                </FieldLabel>
              </Field>
              <div className="min-w-0 space-y-1 ps-11">
                {context.details}
                <p id={previewId} className="text-sm text-muted-foreground">
                  {preview.ok ? m.facts_reuse_preview_add({}, o) : refusalText(preview.reason, locale)}
                </p>
              </div>
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
              const context = draft ? assertionView(draft, `${titleId}-selected-${holder}`) : undefined;
              return (
                <li key={holder} className="min-w-0 space-y-1">
                  {context?.content ?? <span className="break-words">{holder}</span>}
                  <p>{draft ? m.facts_reuse_preview_add({}, o) : m.facts_reuse_reason_missing({}, o)}</p>
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
      {!!applied.length && <p role="status">{m.facts_reuse_applied({ count: applied.length }, o)}</p>}
      {refused.map((item) => {
        const draft = drafts.find((candidate) => factHolder(candidate) === item.holder);
        const context = draft ? assertionView(draft, `${titleId}-refused-${item.holder}`) : undefined;
        return (
          <div key={`${item.holder}:${item.reason}`} role="status" className="min-w-0 space-y-1 text-sm">
            {context?.content}
            <p>
              {m.facts_reuse_refused(
                {
                  field: pageText(read.release.properties[item.property]?.labels, locale).text || item.property,
                  reason: refusalText(item.reason, locale),
                },
                o,
              )}
            </p>
          </div>
        );
      })}
      {applied.map((item) => {
        const draft = drafts.find((candidate) => factHolder(candidate) === item.holder);
        const context = draft ? assertionView(draft, `${titleId}-applied-${item.holder}`) : undefined;
        const fallbackId = `${titleId}-applied-${item.holder}-fallback`;
        const actionId = `${titleId}-applied-${item.holder}-action`;
        return (
          <div key={item.holder} className="min-w-0 space-y-2">
            {context?.content ?? (
              <p id={fallbackId} className="break-words text-sm">
                {pageText(read.release.properties[item.property]?.labels, locale).text || item.property}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className={wrap}
              aria-labelledby={`${actionId} ${(context?.labelIds ?? [fallbackId]).join(' ')}`}
              onClick={() => onOpen(item.holder, item.index)}
            >
              <span id={actionId}>{m.facts_reuse_open_copy({}, o)}</span>
            </Button>
          </div>
        );
      })}
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
