import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { StatementSummary } from './statement-summary';
import { statementInput } from './statement-editor';
import {
  factOutcome,
  type ChangedFactView,
  type FactDraft,
  type FactOutcomeKind,
  type FactsCurrent,
} from './subject-facts';

const wrap = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2';

export function FactsChangedReview({
  items,
  read,
  locale,
  stale,
  onJump,
}: {
  items: ChangedFactView[];
  read: FactsCurrent;
  locale: string;
  stale: boolean;
  onJump: (holder: string) => void;
}) {
  const o = { locale: locale as never };
  return (
    <section data-fact-review className="min-w-0 space-y-4" aria-label={m.facts_review_title({}, o)}>
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.facts_review_title({}, o)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.facts_review_intro({}, o)}</p>
      <p className="text-sm text-muted-foreground">{m.facts_review_independent({}, o)}</p>
      {stale && (
        <p role="status" className="text-sm">
          {m.facts_review_stale({}, o)}
        </p>
      )}
      {!items.length && <p className="text-sm text-muted-foreground">{m.facts_review_none({}, o)}</p>}
      <ol className="min-w-0 space-y-4">
        {items.map((item) => {
          const definition = read.release.properties[item.property];
          const label = pageText(definition?.labels, locale).text || m.subject_value_unlabelled({}, o);
          const current = item.source
            ? (read.public.subject.statements[item.property] ?? []).find((statement) => statement.id === item.source)
            : undefined;
          const baseline = current ? { ...statementInput(current), rank: current.rank } : item.baseline;
          return (
            <li key={item.holder}>
              <ContentItemFrame as="div" className="min-w-0 space-y-4 rounded-xl bg-muted/30 p-4">
                <ContentItemHeading
                  level={3}
                  className="text-base font-semibold"
                  lang={pageText(definition?.labels, locale).lang}
                >
                  {label}
                </ContentItemHeading>
                <div className="grid min-w-0 gap-4 md:grid-cols-2">
                  <section className="min-w-0 space-y-2" aria-label={m.facts_review_current({}, o)}>
                    <h4 className="text-sm font-semibold text-muted-foreground">{m.facts_review_current({}, o)}</h4>
                    {baseline ? (
                      <StatementSummary statement={baseline} read={read} locale={locale} />
                    ) : (
                      <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
                    )}
                  </section>
                  <section className="min-w-0 space-y-2" aria-label={m.facts_review_proposed({}, o)}>
                    <h4 className="text-sm font-semibold">{m.facts_review_proposed({}, o)}</h4>
                    <StatementSummary statement={item.statement} read={read} locale={locale} />
                  </section>
                </div>
                <Button type="button" variant="outline" className={wrap} onClick={() => onJump(item.holder)}>
                  {m.facts_review_open_field({}, o)}
                </Button>
              </ContentItemFrame>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const outcomeMessage: Record<FactOutcomeKind, (locale: string) => string> = {
  proposed: (locale) => m.facts_result_proposed({}, { locale: locale as never }),
  selected: (locale) => m.facts_result_selected({}, { locale: locale as never }),
  refused: (locale) => m.facts_result_refused({}, { locale: locale as never }),
  uncertain: (locale) => m.facts_result_uncertain({}, { locale: locale as never }),
  editable: (locale) => m.facts_result_editable({}, { locale: locale as never }),
};

export function FactsResultBoard({
  drafts,
  read,
  locale,
}: {
  drafts: FactDraft[];
  read: FactsCurrent;
  locale: string;
}) {
  const o = { locale: locale as never };
  const groups: Record<FactOutcomeKind, FactDraft[]> = {
    proposed: [],
    selected: [],
    refused: [],
    uncertain: [],
    editable: [],
  };
  for (const draft of drafts) {
    const kind = factOutcome(draft, read);
    if (kind) groups[kind].push(draft);
    if (kind === 'refused' && !draft.command && draft.included && draft.result && !draft.result.ok)
      groups.editable.push(draft);
  }
  if (!drafts.some((draft) => draft.result)) return null;
  return (
    <section data-fact-results className="min-w-0 space-y-3" aria-label={m.facts_result_board({}, o)}>
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.facts_result_board({}, o)}
      </ContentItemHeading>
      {(Object.keys(groups) as FactOutcomeKind[]).map((kind) => (
        <div key={kind} className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">{outcomeMessage[kind](locale)}</h3>
          {groups[kind].length ? (
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {groups[kind].map((draft) => (
                <li key={`${kind}:${draft.holder ?? draft.property}`}>
                  {pageText(read.release.properties[draft.property]?.labels, locale).text || draft.property}
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
