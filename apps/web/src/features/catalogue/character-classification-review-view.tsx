import { ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/shared';
import { PartValue } from './statement-editor-view';
import { type ReuseCapture, type ReuseRefusal, type ReuseSource } from './reference-reuse';
import { ReferenceReusePanel } from './reference-reuse-view';
import { FactsChangedReview, FactsResultBoard } from './subject-facts-review';
import {
  factHolder,
  factLimit,
  includedChanges,
  projectChangedSet,
  type ChangedSetReview,
  type FactDraft,
  type FactsCurrent,
} from './subject-facts';
import {
  classificationAdmitted,
  classificationBaselineKind,
  classificationConfirmable,
  classificationReuseReason,
  classificationRetainedOutcomes,
  classificationReviewableDrafts,
  focusableClassificationHolder,
  retainedClassificationSiblings,
  selectedClassificationTarget,
  type RemovedHolderDiagnostic,
} from './character-classification-review';

const wrap =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

function reuseReasonText(reason: NonNullable<ReturnType<typeof classificationReuseReason>>, locale: string) {
  const o = { locale: locale as never };
  return reason === 'retired'
    ? m.classification_copy_retired({}, o)
    : reason === 'succeeded'
      ? m.classification_copy_succeeded({}, o)
      : reason === 'uncertain'
        ? m.classification_copy_uncertain({}, o)
        : reason === 'locked'
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

export function ClassificationSelectedValues({
  property,
  read,
  locale,
}: {
  property: string;
  read: FactsCurrent;
  locale: string;
}) {
  const o = { locale: locale as never };
  const selected = read.public.subject.statements[property] ?? [];
  if (!selected.length) return <p className="text-sm text-muted-foreground">{m.classification_absence({}, o)}</p>;
  return (
    <ol className="min-w-0 space-y-2" aria-label={m.facts_choose_value({}, o)}>
      {selected.map((statement, index) => {
        const target = selectedClassificationTarget(statement, read.public.related, locale);
        return (
          <li key={statement.id} data-classification-selected={statement.id} className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">{m.facts_selected_value({ number: index + 1 }, o)}</p>
            {target.state === 'hidden' ? (
              <p className="text-muted-foreground">{m.classification_selected_hidden({ id: target.id }, o)}</p>
            ) : (
              <>
                <p>
                  <span lang={target.lang}>{target.label || m.subject_value_unlabelled({}, o)}</span>
                  {target.id ? ` · ${target.id}` : ''}
                </p>
                <PartValue part={statement} read={read} locale={locale} />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ClassificationChangedSet({
  items,
  drafts,
  read,
  locale,
  stale,
  readFailed,
  retained,
  onJump,
}: {
  items: ReturnType<typeof projectChangedSet>;
  drafts: FactDraft[];
  read: FactsCurrent;
  locale: string;
  stale: boolean;
  readFailed: boolean;
  retained: FactDraft[];
  onJump: (holder: string) => void;
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-4" data-classification-review>
      <FactsChangedReview items={items} read={read} locale={locale} stale={stale} onJump={onJump} />
      <p className="text-sm text-muted-foreground">{m.classification_review_native({}, o)}</p>
      {readFailed && <p role="status">{m.classification_read_failed({}, o)}</p>}
      {!!retained.length && (
        <p className="text-sm text-muted-foreground">{m.classification_retained_locked({}, o)}</p>
      )}
      <ul className="min-w-0 space-y-2 text-sm">
        {items.map((item) => {
          const draft = drafts.find((entry) => factHolder(entry) === item.holder);
          const baseline = classificationBaselineKind(item, read, item.property);
          const siblings = draft ? retainedClassificationSiblings(read, draft) : [];
          return (
            <li key={item.holder} className="min-w-0 space-y-1">
              <p>
                {baseline === 'absent'
                  ? m.classification_baseline_absent({}, o)
                  : baseline === 'withdrawn'
                    ? m.classification_baseline_withdrawn({}, o)
                    : baseline === 'unread'
                      ? m.classification_read_failed({}, o)
                      : m.facts_review_current({}, o)}
              </p>
              {!!siblings.length && <p className="text-muted-foreground">{m.classification_siblings_retained({}, o)}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function RemovedClassificationDiagnostics({
  items,
  drafts,
  locale,
  onFocus,
}: {
  items: RemovedHolderDiagnostic[];
  drafts: FactDraft[];
  locale: string;
  onFocus: (holder: string) => void;
}) {
  const o = { locale: locale as never };
  if (!items.length) return null;
  return (
    <section className="min-w-0 space-y-2" aria-label={m.classification_removed_holder({}, o)}>
      {items.map((item) => {
        const focusable = focusableClassificationHolder(item.holder, drafts, items);
        return (
          <p key={item.holder} role="status" className="text-sm">
            {m.classification_removed_holder({}, o)}
            {focusable ? (
              <Button type="button" variant="outline" className={`${wrap} ms-2`} onClick={() => onFocus(focusable)}>
                {m.facts_review_open_field({}, o)}
              </Button>
            ) : null}
          </p>
        );
      })}
    </section>
  );
}

export function ClassificationReviewWorkspace({
  drafts,
  read,
  locale,
  changedReview,
  busy,
  success,
  readFailed,
  reuse,
  orphans,
  onReview,
  onConfirm,
  onJump,
  onReadCurrent,
  onReuseSelected,
  onReuseApply,
  onReuseCancel,
  onReuseRefresh,
  onReuseOpen,
}: {
  drafts: FactDraft[];
  read: FactsCurrent;
  locale: string;
  changedReview: ChangedSetReview;
  busy: boolean;
  success: number;
  readFailed: boolean;
  reuse: {
    source: ReuseSource;
    selected: string[];
    capture: ReuseCapture;
    applied: { holder: string; property: string; index: number }[];
    refused: { holder: string; property: string; reason: ReuseRefusal }[];
  } | null;
  orphans: RemovedHolderDiagnostic[];
  onReview: () => void;
  onConfirm: () => void;
  onJump: (holder: string) => void;
  onReadCurrent: () => void;
  onReuseSelected: (holders: string[]) => void;
  onReuseApply: () => void;
  onReuseCancel: () => void;
  onReuseRefresh: () => void;
  onReuseOpen: (holder: string, index: number) => void;
}) {
  const o = { locale: locale as never };
  const changed = includedChanges(drafts);
  const items = projectChangedSet(classificationReviewableDrafts(drafts));
  const retained = classificationRetainedOutcomes(drafts, read);
  const admitted = new Set(
    [...new Set(drafts.map((draft) => draft.property))].filter((property) => classificationAdmitted(read, property)),
  );
  const confirmable = classificationConfirmable({
    drafts,
    reviewCurrent: changedReview.status === 'current',
    admitted,
    readFailed,
  });
  return (
    <div className="min-w-0 space-y-4">
      {changedReview.status !== 'closed' && (
        <ClassificationChangedSet
          items={items}
          drafts={drafts}
          read={read}
          locale={locale}
          stale={changedReview.status === 'stale'}
          readFailed={readFailed}
          retained={retained}
          onJump={onJump}
        />
      )}
      <FactsResultBoard drafts={drafts} read={read} locale={locale} />
      <RemovedClassificationDiagnostics items={orphans} drafts={drafts} locale={locale} onFocus={onJump} />
      <section className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5">
        <ContentItemHeading level={2} className="text-lg font-semibold">
          {m.facts_selection({ count: changed.length, limit: factLimit }, o)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.classification_review_native({}, o)}</p>
        {!!success && <p role="status">{m.facts_results({ count: success }, o)}</p>}
        {busy && <p role="status">{m.correction_saving({}, o)}</p>}
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="button" variant="outline" className={wrap} disabled={busy || !changed.length} onClick={onReview}>
            {m.facts_review({}, o)}
          </Button>
          <Button type="button" className={wrap} disabled={busy || !confirmable} onClick={onConfirm}>
            {m.facts_submit({}, o)}
          </Button>
          <Button type="button" variant="outline" className={wrap} disabled={busy} onClick={onReadCurrent}>
            {m.classification_read_current({}, o)}
          </Button>
        </div>
      </section>
      {reuse && (
        <ClassificationReuse
          source={reuse.source}
          drafts={drafts}
          selected={reuse.selected}
          read={read}
          locale={locale}
          capture={reuse.capture}
          applied={reuse.applied}
          refused={reuse.refused}
          onSelected={onReuseSelected}
          onApply={onReuseApply}
          onCancel={onReuseCancel}
          onRefresh={onReuseRefresh}
          onOpen={onReuseOpen}
        />
      )}
    </div>
  );
}

function ClassificationReuse({
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
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  const group = origin?.statement.references[source.groupIndex] ?? source.snapshot;
  const admitted = (property: string) =>
    !!read.release.types[read.public.subject.type]?.properties.includes(property) &&
    read.release.properties[property]?.relation?.group === 'classification';
  return (
    <div className="min-w-0 space-y-3">
      <ul className="min-w-0 space-y-1 text-sm">
        {drafts
          .filter((draft) => factHolder(draft) !== source.holder)
          .map((draft) => {
            const reason = classificationReuseReason(draft, group, read.release, source.holder, admitted(draft.property));
            if (!reason || reason === 'self') return null;
            return (
              <li key={factHolder(draft)}>
                {pageText(read.release.properties[draft.property]?.labels, locale).text || draft.property}:{' '}
                {reuseReasonText(reason, locale)}
              </li>
            );
          })}
      </ul>
      <ReferenceReusePanel
        source={source}
        drafts={drafts}
        selected={selected}
        read={read}
        locale={locale}
        capture={capture}
        applied={applied}
        refused={refused}
        onSelected={onSelected}
        onApply={onApply}
        onCancel={onCancel}
        onRefresh={onRefresh}
        onOpen={onOpen}
      />
      <p className="text-sm text-muted-foreground">{m.facts_reuse_intro({}, o)}</p>
    </div>
  );
}
