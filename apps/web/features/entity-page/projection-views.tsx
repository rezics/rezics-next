import type { Names } from '../work-levels/types.ts';
import { Region, RegionFailure } from '../work-page/region.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import type { Loaded } from '../work-page/types.ts';
import type { Copy } from './messages.ts';
import type { HrefFor, StatementItem, StatementPage } from './types.ts';
import { Pages, Quiet, Value } from './views.tsx';
import { LocalizedText } from '@rezics/ui/localized-text';
import type { PredicateLabels } from './predicate-labels.ts';

// A place's facts. Main answers only what holds within the place's coordinates, most specific first, and says how far each
// claim reaches (`frameMatch`); this page keeps Main's order and groups it by that reach, never by a rule of its own.

type Reach = 'here' | 'wider' | 'everywhere';
const reaches: readonly Reach[] = ['here', 'wider', 'everywhere'];

/** `exact` counts the place's own coordinates the claim names; `dimensions` the kinds of place it constrains at all. */
export function reachOf(item: StatementItem): Reach {
  const match = item.frameMatch;
  if (!match || match.dimensions === 0) return 'everywhere';
  return match.exact > 0 ? 'here' : 'wider';
}

export function ProjectionFactsView({
  page,
  labels = new Map(),
  names,
  cursor,
  hrefFor,
  t,
  messages,
}: {
  page: Loaded<StatementPage>;
  labels?: PredicateLabels;
  names: Names;
  cursor: string | undefined;
  hrefFor: HrefFor;
  t: Copy;
  messages: WorkPageMessages;
}) {
  if (!page.ok) {
    return (
      <Region id="statements" title={t.projectionFacts}>
        <RegionFailure
          title={t.statementsUnavailable}
          failure={page.failure}
          messages={messages}
          restartHref={hrefFor({ kind: 'continue', section: 'statements', cursor: null })}
        />
      </Region>
    );
  }
  const claims = page.data.groups.flatMap((group) =>
    group.items.map((item) => ({ predicate: group.predicate, item })),
  );
  const titles: Record<Reach, string> = {
    here: t.factsHere,
    wider: t.factsWider,
    everywhere: t.factsEverywhere,
  };
  return (
    <Region id="statements" title={t.projectionFacts}>
      {claims.length ? (
        <div aria-label={t.statementsList} className="grid gap-6">
          {reaches.map((reach) => {
            const inReach = claims.filter(({ item }) => reachOf(item) === reach);
            if (!inReach.length) return null;
            return (
              <section key={reach} data-fact-reach={reach} className="grid gap-2">
                <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {titles[reach]}
                </h3>
                <dl className="grid gap-2">
                  {inReach.map(({ predicate, item }, index) => (
                    <div
                      key={`${item.revision}-${index}`}
                      className={labels.has(predicate) ? 'grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4' : 'grid gap-1'}
                    >
                      <dt
                        className="break-words font-medium text-muted-foreground text-sm"
                      >
                        {labels.get(predicate) ? <LocalizedText text={labels.get(predicate)!} /> : null}
                      </dt>
                      <dd className="min-w-0">
                        <Value item={item} names={names} hrefFor={hrefFor} t={t} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      ) : (
        <Quiet title={t.noStatements} body={t.noStatementsBody} />
      )}
      <Pages
        cursor={cursor}
        next={page.data.nextCursor}
        section="statements"
        hrefFor={hrefFor}
        messages={messages}
      />
    </Region>
  );
}
