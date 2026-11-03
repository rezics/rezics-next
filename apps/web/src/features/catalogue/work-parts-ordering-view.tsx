import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { CandidateValue } from '../pages/data';
import { m } from '../../paraglide/messages.js';
import { pickText } from '@rezics/composition';
import type { PartStream } from './work-parts';
import {
  applyOrderingPosition,
  includedOrderingChanges,
  orderingChanged,
  orderingLimit,
  orderingLocked,
  orderingOutcome,
  orderingUncertain,
  pageOrderingDrafts,
  type OrderingDraft,
  type OrderingOutcome,
  type OrderingReview,
} from './work-parts-ordering';

const wrap =
  'h-auto min-h-8 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1.5 max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';

function identityLabel(draft: OrderingDraft, locale: string) {
  return draft.summary?.label?.value || m.subject_value_unlabelled({}, { locale: locale as never });
}

function AssertionReadout({
  draft,
  labels,
  locale,
}: {
  draft: OrderingDraft;
  labels: Record<string, ReturnType<typeof pickText>>;
  locale: string;
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <CandidateValue snak={draft.statement} related={draft.related} locale={locale} />
      {draft.statement.qualifiers.map((snak, index) => (
        <div key={index}>
          <p lang={labels[snak.property.id]?.lang ?? undefined} className="text-muted-foreground">
            {labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
          </p>
          <CandidateValue snak={snak} related={draft.related} locale={locale} />
        </div>
      ))}
      <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
        <h4 className="font-medium">{m.sources_citations({}, o)}</h4>
        {draft.statement.references.length ? (
          draft.statement.references.map((reference, index) => (
            <div key={index} className="space-y-2 border-s-2 border-border ps-3">
              {reference.parts.length ? (
                reference.parts.map((snak, at) => (
                  <div key={at}>
                    <p lang={labels[snak.property.id]?.lang ?? undefined} className="text-muted-foreground">
                      {labels[snak.property.id]?.text || m.subject_value_unlabelled({}, o)}
                    </p>
                    <CandidateValue snak={snak} related={draft.related} locale={locale} />
                  </div>
                ))
              ) : (
                <p>{m.value_reference_unavailable({}, o)}</p>
              )}
            </div>
          ))
        ) : (
          <p>{m.sources_no_citations({}, o)}</p>
        )}
      </section>
    </div>
  );
}

export function WorkPartsOrderingSelect({
  selected,
  busy,
  disabled = false,
  locale,
  controlId,
  onToggle,
}: {
  selected: boolean;
  busy: boolean;
  disabled?: boolean;
  locale: string;
  controlId: string;
  onToggle: (checked: boolean) => void;
}) {
  const o = { locale: locale as never };
  return (
    <Field orientation="horizontal" className="min-w-0">
      <Checkbox
        id={controlId}
        className="size-11 after:inset-0"
        checked={selected}
        disabled={busy || disabled}
        onCheckedChange={(value) => onToggle(value === true)}
      />
      <FieldLabel
        className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]"
        htmlFor={controlId}
      >
        {m.work_parts_order_select({}, o)}
      </FieldLabel>
    </Field>
  );
}

const outcomeMessage: Record<OrderingOutcome, (locale: string) => string> = {
  proposed: (locale) => m.work_parts_order_result_proposed({}, { locale: locale as never }),
  uncertain: (locale) => m.work_parts_order_result_uncertain({}, { locale: locale as never }),
  refused: (locale) => m.work_parts_order_result_refused({}, { locale: locale as never }),
  editable: (locale) => m.work_parts_order_result_editable({}, { locale: locale as never }),
};

export function WorkPartsOrderingBoard({
  stream,
  cursor,
  labels,
  locale,
  drafts,
  review,
  busy,
  onChange,
  onReview,
  onSubmit,
  onJump,
  onDiscard,
  onOpenCandidate,
}: {
  stream: PartStream;
  cursor?: string;
  labels: Record<string, ReturnType<typeof pickText>>;
  locale: string;
  drafts: OrderingDraft[];
  review: OrderingReview;
  busy: boolean;
  onChange: (draft: OrderingDraft) => void;
  onReview: () => void;
  onSubmit: () => void;
  onJump: (key: string) => void;
  onDiscard: () => void;
  onOpenCandidate: (draft: OrderingDraft) => void;
}) {
  const o = { locale: locale as never };
  const titleId = useId();
  const page = pageOrderingDrafts(drafts, stream.key, cursor);
  const changed = includedOrderingChanges(drafts);
  const unsent = page.some((draft) => orderingChanged(draft) && !draft.command && !orderingLocked(draft));
  const unsealed = changed.some((draft) => !draft.command);
  const [discard, setDiscard] = useState(false);
  const discardCancel = useRef<HTMLButtonElement>(null);
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const restoreDiscard = useRef(false);
  useLayoutEffect(() => {
    if (restoreDiscard.current) {
      restoreDiscard.current = false;
      discardTrigger.current?.focus();
    }
  }, [discard]);
  if (!page.length && !drafts.some((draft) => draft.command || draft.result)) return null;
  return (
    <section data-ordering-board className="min-w-0 space-y-4 rounded-lg border border-border p-4" aria-labelledby={titleId}>
      <ContentItemHeading id={titleId} level={2} className="font-sans text-lg font-semibold">
        {m.work_parts_order_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.work_parts_order_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.work_parts_order_partial({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.work_parts_order_limit({ count: orderingLimit }, o)}</p>
      {!!page.length && (
        <ol className="min-w-0 space-y-4">
          {page.map((draft) => {
            const locked = orderingLocked(draft) || busy;
            const positionId = `${titleId}-${draft.key}-position`;
            const headingId = `${titleId}-${draft.key}`;
            return (
              <li key={draft.key}>
                <ContentItemFrame as="div" className="min-w-0 space-y-3">
                  <ContentItemHeading
                    id={headingId}
                    data-ordering-holder={draft.key}
                    tabIndex={-1}
                    level={3}
                    lang={draft.summary?.label?.language}
                    className="font-sans text-base font-semibold"
                  >
                    {identityLabel(draft, locale)}
                  </ContentItemHeading>
                  <p className="text-sm text-muted-foreground">
                    {draft.direction === 'forward' ? m.work_parts_order_forward({}, o) : m.work_parts_order_inverse({}, o)}
                  </p>
                  <p className="text-sm">
                    {m.work_parts_holder({}, o)}: <code className="break-all text-xs">{draft.holder}</code>
                  </p>
                  <p className="text-sm">
                    {m.work_parts_order_current({}, o)}:{' '}
                    {draft.currentPosition || m.work_parts_order_missing({}, o)}
                  </p>
                  <Field>
                    <FieldLabel htmlFor={positionId}>{m.work_parts_order_proposed({}, o)}</FieldLabel>
                    <Input
                      id={positionId}
                      value={draft.proposedPosition}
                      disabled={locked || !draft.admitted}
                      onChange={(event) => onChange(applyOrderingPosition(draft, event.target.value))}
                    />
                  </Field>
                  {draft.positionIsSlotKey && (
                    <p className="text-sm" role="status">
                      {m.work_parts_order_slot_new({}, o)}
                    </p>
                  )}
                  {!draft.positionIsSlotKey && (
                    <p className="text-sm text-muted-foreground">{m.work_parts_order_slot_same({}, o)}</p>
                  )}
                  {draft.positionIsSlotKey && (
                    <dl className="space-y-1 text-sm [&_dd]:break-all [&_dd]:font-mono [&_dd]:text-xs">
                      <div>
                        <dt>{m.work_parts_order_original_slot({}, o)}</dt>
                        <dd>{JSON.stringify(draft.originalSlot ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{m.work_parts_order_proposed_slot({}, o)}</dt>
                        <dd>{JSON.stringify(draft.slot ?? null)}</dd>
                      </div>
                    </dl>
                  )}
                  {!draft.admitted && (
                    <p role="status" className="text-sm">
                      {draft.disabledReason === 'definition'
                        ? m.work_parts_order_disabled_definition({}, o)
                        : m.work_parts_order_disabled_holder({}, o)}
                    </p>
                  )}
                  <AssertionReadout draft={draft} labels={labels} locale={locale} />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      className={wrap}
                      variant="outline"
                      disabled={locked || !!draft.command}
                      onClick={() => onChange({ ...draft, included: false })}
                    >
                      {m.work_parts_order_exclude({}, o)}
                    </Button>
                    <Button type="button" className={wrap} variant="outline" onClick={() => onJump(draft.key)}>
                      {m.work_parts_order_repair({}, o)}
                    </Button>
                  </div>
                </ContentItemFrame>
              </li>
            );
          })}
        </ol>
      )}
      <section data-ordering-preview className="min-w-0 space-y-2" aria-label={m.work_parts_order_preview({}, o)}>
        <h3 className="text-sm font-semibold">{m.work_parts_order_preview({}, o)}</h3>
        <ol className="min-w-0 space-y-1 text-sm">
          {page.map((draft) => (
            <li key={draft.key}>
              {identityLabel(draft, locale)}: {draft.proposedPosition || m.work_parts_order_missing({}, o)}
            </li>
          ))}
        </ol>
      </section>
      <WorkPartsOrderingReview
        items={changed}
        labels={labels}
        locale={locale}
        stale={review.status === 'stale'}
        onJump={onJump}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={wrap} variant="outline" disabled={busy || !changed.length} onClick={onReview}>
          {m.work_parts_order_review({}, o)}
        </Button>
        <Button
          type="button"
          className={wrap}
          disabled={busy || !changed.length || (unsealed && review.status !== 'current')}
          onClick={onSubmit}
        >
          {m.work_parts_order_submit({}, o)}
        </Button>
        {unsent && (
          <Button
            ref={discardTrigger}
            type="button"
            className={wrap}
            variant="outline"
            disabled={busy}
            onClick={() => setDiscard(true)}
          >
            {m.work_parts_order_discard({}, o)}
          </Button>
        )}
      </div>
      {discard && (
        <div role="group" aria-label={m.work_parts_order_discard({}, o)} className="space-y-2 rounded-lg border border-border p-3">
          <p>{m.work_parts_order_discard_confirm({}, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className={wrap}
              onClick={() => {
                setDiscard(false);
                onDiscard();
              }}
            >
              {m.work_parts_order_discard({}, o)}
            </Button>
            <Button
              ref={discardCancel}
              type="button"
              className={wrap}
              variant="outline"
              onClick={() => {
                restoreDiscard.current = true;
                setDiscard(false);
              }}
            >
              {m.work_parts_order_discard_keep({}, o)}
            </Button>
          </div>
        </div>
      )}
      <WorkPartsOrderingResults drafts={drafts} locale={locale} onOpenCandidate={onOpenCandidate} />
    </section>
  );
}

export function WorkPartsOrderingReview({
  items,
  labels,
  locale,
  stale,
  onJump,
}: {
  items: OrderingDraft[];
  labels: Record<string, ReturnType<typeof pickText>>;
  locale: string;
  stale: boolean;
  onJump: (key: string) => void;
}) {
  const o = { locale: locale as never };
  return (
    <section data-ordering-review className="min-w-0 space-y-3" aria-label={m.work_parts_order_review_title({}, o)}>
      <ContentItemHeading level={3} className="text-base font-semibold">
        {m.work_parts_order_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.work_parts_order_review_intro({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.work_parts_order_stale({}, o)}
        </p>
      )}
      {!items.length && <p className="text-sm text-muted-foreground">{m.work_parts_order_none({}, o)}</p>}
      <ol className="min-w-0 space-y-4">
        {items.map((item) => (
          <li key={item.key}>
            <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <ContentItemHeading level={4} lang={item.summary?.label?.language} className="text-sm font-semibold">
                {identityLabel(item, locale)}
              </ContentItemHeading>
              <p className="text-sm text-muted-foreground">
                {item.direction === 'forward' ? m.work_parts_order_forward({}, o) : m.work_parts_order_inverse({}, o)}
              </p>
              {item.positionIsSlotKey ? (
                <p className="text-sm">{m.work_parts_order_slot_new({}, o)}</p>
              ) : (
                <p className="text-sm">{m.work_parts_order_slot_same({}, o)}</p>
              )}
              <div className="grid min-w-0 gap-3 md:grid-cols-2">
                <p>
                  {m.work_parts_order_current({}, o)}: {item.currentPosition || m.work_parts_order_missing({}, o)}
                </p>
                <p>
                  {m.work_parts_order_proposed({}, o)}: {item.proposedPosition}
                </p>
              </div>
              <AssertionReadout draft={item} labels={labels} locale={locale} />
              <Button type="button" className={wrap} variant="outline" onClick={() => onJump(item.key)}>
                {m.work_parts_order_repair({}, o)}
              </Button>
            </ContentItemFrame>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function WorkPartsOrderingResults({
  drafts,
  locale,
  onOpenCandidate,
}: {
  drafts: OrderingDraft[];
  locale: string;
  onOpenCandidate: (draft: OrderingDraft) => void;
}) {
  const o = { locale: locale as never };
  const groups: Record<OrderingOutcome, OrderingDraft[]> = { proposed: [], uncertain: [], refused: [], editable: [] };
  for (const draft of drafts) {
    const kind = orderingOutcome(draft);
    if (kind) groups[kind].push(draft);
  }
  if (!drafts.some((draft) => draft.result || draft.command)) return null;
  return (
    <section data-ordering-results className="min-w-0 space-y-3" aria-label={m.work_parts_order_results({}, o)}>
      <ContentItemHeading level={3} className="text-base font-semibold">
        {m.work_parts_order_results({}, o)}
      </ContentItemHeading>
      {(Object.keys(groups) as OrderingOutcome[]).map((kind) => (
        <div key={kind} className="min-w-0 space-y-1">
          <h4 className="text-sm font-semibold">{outcomeMessage[kind](locale)}</h4>
          {groups[kind].length ? (
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {groups[kind].map((draft) => (
                <li key={`${kind}:${draft.key}`}>
                  {identityLabel(draft, locale)}
                  {draft.present === false && ` — ${m.work_parts_order_absent({}, o)}`}
                  {draft.present && ` — ${m.work_parts_order_present({}, o)}`}
                  {draft.result?.ok && (
                    <Button type="button" className={`${wrap} ms-2`} variant="outline" onClick={() => onOpenCandidate(draft)}>
                      {m.work_parts_order_review_candidate({}, o)}
                    </Button>
                  )}
                  {orderingUncertain(draft.result) && (
                    <code className="ms-2 break-all text-xs">{draft.command?.key}</code>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </div>
      ))}
    </section>
  );
}
