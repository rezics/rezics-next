import { useEffect, useId, useRef, useState } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Slider } from '@rezics/ui/shadcn/slider';
import { cn } from '../utils.ts';
import { MetaLine } from './meta-line.tsx';

/**
 * Rating display and input. shadcn has no rating pattern (its `chart` is a general plotting layer, and a vote
 * distribution of a few dozen bars needs none of it); these compose `badge`, `button` and `slider` and follow the
 * Display rules of the rating module: a score always comes with its population and count, populations are listed
 * separately and never averaged, and a distribution stays hidden below the aggregate's threshold.
 */

/** How stored integer units map to the displayed scale. The standard question stores 0 to 20 and shows 0 to 10. */
export interface RatingScale {
  /** Lowest stored unit. */
  minimum: number;
  /** Highest stored unit. */
  maximum: number;
  /** Stored units per displayed point; 2 shows the standard 0 to 20 units as 0 to 10 in steps of 0.5. */
  unitsPerPoint: number;
}

/** A set of people whose votes an aggregate counts. */
export interface RatingPopulation {
  id: string;
  /** Global is every eligible account; a Realm is its current members. */
  kind: 'global' | 'realm';
  /** The name shown beside every figure, such as "REZICS" or a Realm name. */
  label: string;
}

/** One question's aggregate over one population and target, as the rating module returns it. */
export interface RatingAggregate {
  population: RatingPopulation;
  /** Votes counted. Zero means nothing is drawn. */
  count: number;
  /** Sum of the counted votes in stored units. The mean is computed from it, never stored. */
  sum: number;
  /** Votes per stored unit, from `scale.minimum` upwards. */
  histogram: readonly number[];
  /** Votes needed before the mean and the distribution are published. */
  threshold: number;
  /** True while a membership change is still being applied to this population. */
  updating?: boolean;
}

/** A score imported from another source. It keeps its own scale and is never merged into a native figure. */
export interface ImportedRating {
  /** The source's name, such as "VNDB". */
  source: string;
  mean: number;
  count: number;
  /** The source's own scale, in the source's own points. */
  scale: { minimum: number; maximum: number };
  /** ISO date the figure was read. */
  asOf: string;
}

export interface RatingLabels {
  /** Names the summary when no question is given. */
  title: string;
  /** Spoken after a score; `{max}` is the top of the scale. */
  outOf: string;
  globalOne: string;
  globalOther: string;
  realmOne: string;
  realmOther: string;
  /** No votes at all. `{population}` is the population name. */
  noneGlobal: string;
  noneRealm: string;
  /** Shown below the threshold. `{count}` is how many more votes reveal the score. */
  moreOne: string;
  moreOther: string;
  /** Why the distribution is hidden. `{threshold}` is the votes needed. */
  distributionHidden: string;
  distribution: string;
  /** Column headings of the distribution table read by assistive technology. */
  distributionScore: string;
  distributionVotes: string;
  updating: string;
  /** One line when the page's context is a Realm. `{population}` is the Realm name. */
  realmContext: string;
  others: string;
  /** `{count}` is how many more populations the list holds. */
  showMore: string;
  showFewer: string;
  imported: string;
  importedNote: string;
  /** One imported figure. `{score}`, `{max}`, `{count}` and `{date}` are filled in. */
  importedLine: string;
  own: string;
  ownHint: string;
}

export const ratingLabels: RatingLabels = {
  title: 'Ratings',
  outOf: 'out of {max}',
  globalOne: '{count} rating on {population}',
  globalOther: '{count} ratings on {population}',
  realmOne: '{count} rating in {population}',
  realmOther: '{count} ratings in {population}',
  noneGlobal: 'No ratings yet on {population}',
  noneRealm: 'No ratings yet in {population}',
  moreOne: '{count} more rating to show a score',
  moreOther: '{count} more ratings to show a score',
  distributionHidden: 'The distribution appears from {threshold} ratings, so no one’s individual rating can be told.',
  distribution: 'Distribution of ratings',
  distributionScore: 'Rating',
  distributionVotes: 'Ratings',
  updating: 'Updating',
  realmContext: 'Showing ratings from {population}.',
  others: 'Other populations',
  showMore: 'Show {count} more',
  showFewer: 'Show fewer',
  imported: 'Imported scores',
  importedNote: 'From other sites on their own scales. Never combined with the figures above.',
  importedLine: '{score} out of {max} · {count} ratings · as of {date}',
  own: 'Your rating',
  ownHint: 'Only you can see this.',
};

function resolveLabels<T extends object>(defaults: T, override?: Partial<T>): T {
  const resolved = { ...defaults };
  if (override === undefined) return resolved;
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = override[key];
    if (value !== undefined) resolved[key] = value as T[keyof T];
  }
  return resolved;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const number = (locale: string, value: number, digits: [number, number]) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits[0], maximumFractionDigits: digits[1] }).format(value);

/** The mean in displayed points, computed from the aggregate's components. Null while nothing is published. */
export function ratingMean(aggregate: RatingAggregate, scale: RatingScale): number | null {
  if (aggregate.count <= 0 || aggregate.count < aggregate.threshold) return null;
  return aggregate.sum / aggregate.count / scale.unitsPerPoint;
}

type Publication = 'none' | 'withheld' | 'published';

function publication(aggregate: RatingAggregate): Publication {
  if (aggregate.count <= 0) return 'none';
  return aggregate.count < aggregate.threshold ? 'withheld' : 'published';
}

function countLine(locale: string, labels: RatingLabels, aggregate: RatingAggregate): string {
  const { population, count } = aggregate;
  const one = new Intl.PluralRules(locale).select(count) === 'one';
  const template =
    population.kind === 'global'
      ? one
        ? labels.globalOne
        : labels.globalOther
      : one
        ? labels.realmOne
        : labels.realmOther;
  return fill(template, { count: number(locale, count, [0, 0]), population: population.label });
}

function moreLine(locale: string, labels: RatingLabels, aggregate: RatingAggregate): string {
  const missing = aggregate.threshold - aggregate.count;
  const one = new Intl.PluralRules(locale).select(missing) === 'one';
  return fill(one ? labels.moreOne : labels.moreOther, { count: number(locale, missing, [0, 0]) });
}

const topOf = (scale: RatingScale) => scale.maximum / scale.unitsPerPoint;

/** The slider's value in displayed points, back to stored units. */
const toUnits = (value: number | readonly number[], scale: RatingScale): number | null => {
  const points = Array.isArray(value) ? value[0] : value;
  return typeof points === 'number' ? Math.round(points * scale.unitsPerPoint) : null;
};

function Distribution({
  aggregate,
  scale,
  locale,
  labels,
}: {
  aggregate: RatingAggregate;
  scale: RatingScale;
  locale: string;
  labels: RatingLabels;
}) {
  const peak = Math.max(1, ...aggregate.histogram);
  const first = scale.minimum / scale.unitsPerPoint;
  const last = topOf(scale);
  const middle = (first + last) / 2;
  return (
    <figure aria-label={labels.distribution} className="flex flex-col gap-1" data-slot="rating-distribution">
      <div aria-hidden="true" className="flex h-16 items-end gap-px">
        {aggregate.histogram.map((votes, index) => (
          <span
            className={cn('min-w-0 flex-1 rounded-t-sm', votes > 0 ? 'bg-primary' : 'bg-border')}
            // A vote is always visible, however small next to the peak.
            key={index}
            style={{ height: votes > 0 ? `max(${(votes / peak) * 100}%, 3px)` : '1px' }}
          />
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{number(locale, first, [0, 0])}</span>
        <span>{number(locale, middle, [0, 1])}</span>
        <span>{number(locale, last, [0, 0])}</span>
      </div>
      <table className="sr-only">
        <caption>{labels.distribution}</caption>
        <thead>
          <tr>
            <th scope="col">{labels.distributionScore}</th>
            <th scope="col">{labels.distributionVotes}</th>
          </tr>
        </thead>
        <tbody>
          {aggregate.histogram.map((votes, index) => (
            <tr key={index}>
              <th scope="row">{number(locale, (scale.minimum + index) / scale.unitsPerPoint, [0, 1])}</th>
              <td>{number(locale, votes, [0, 0])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Figure({
  aggregate,
  scale,
  locale,
  labels,
  large,
}: {
  aggregate: RatingAggregate;
  scale: RatingScale;
  locale: string;
  labels: RatingLabels;
  large?: boolean;
}) {
  const state = publication(aggregate);
  const mean = ratingMean(aggregate, scale);
  const max = number(locale, topOf(scale), [0, 1]);
  if (state === 'none') {
    return (
      <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
        {fill(aggregate.population.kind === 'global' ? labels.noneGlobal : labels.noneRealm, {
          population: aggregate.population.label,
        })}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex min-w-0 items-baseline gap-x-2">
        <MetaLine
          className="min-w-0 flex-1"
          items={[
            mean === null ? null : (
              <span className={cn('shrink-0 font-semibold tabular-nums', large ? 'text-4xl' : 'text-base')}>
                {number(locale, mean, [1, 1])}
                <span className="sr-only"> {fill(labels.outOf, { max })}</span>
              </span>
            ),
            <span
              className={cn('min-w-0 text-muted-foreground text-sm [overflow-wrap:anywhere]', large && 'text-base')}
            >
              {countLine(locale, labels, aggregate)}
            </span>,
          ]}
        />
      </p>
      {state === 'withheld' ? <p className="text-sm">{moreLine(locale, labels, aggregate)}</p> : null}
    </div>
  );
}

export interface RatingSummaryProps {
  /** The question the figures answer, shown as the summary's name. */
  question?: string;
  scale: RatingScale;
  /** The page's context population: Global on the general site, the Realm on a Realm-routed page or Zone. */
  headline: RatingAggregate;
  /**
   * Every other population that rated the target, in display order (the reader's Realms first, by count).
   * Each keeps its own figure. In a Realm context, the Global entry is shown beside the headline.
   */
  others?: readonly RatingAggregate[];
  /** Imported source scores, shown after the native figures. */
  imported?: readonly ImportedRating[];
  /** The reader's own vote in stored units. Omit it when a `RatingInput` is on the page. */
  own?: number | null;
  locale: string;
  labels?: Partial<RatingLabels>;
  /** How many other populations show before the rest wait behind a control. */
  visibleOthers?: number;
}

/**
 * The rating figures for one subject. The headline is the page's population; other populations are a labelled list
 * and are never averaged into it or substituted for it. With no votes nothing is drawn, and below the threshold only
 * the count and the votes still needed appear, with the reason the distribution is hidden.
 */
export function RatingSummary(props: RatingSummaryProps) {
  const { scale, headline, locale } = props;
  const labels = resolveLabels(ratingLabels, props.labels);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const state = publication(headline);
  const realmContext = headline.population.kind === 'realm';
  const aside = realmContext ? props.others?.find((other) => other.population.kind === 'global') : undefined;
  const others = (props.others ?? []).filter((other) => other !== aside);
  const visible = props.visibleOthers ?? 3;
  const shown = expanded ? others : others.slice(0, visible);
  const imported = props.imported ?? [];
  const own = props.own ?? null;

  return (
    <section
      aria-label={props.question ?? labels.title}
      className="flex min-w-0 flex-col gap-4"
      data-slot="rating-summary"
    >
      <div className="flex min-w-0 flex-col gap-2" data-slot="rating-headline" data-state={state}>
        {realmContext ? (
          <p className="text-muted-foreground text-sm">
            {fill(labels.realmContext, { population: headline.population.label })}
          </p>
        ) : null}
        <Figure aggregate={headline} labels={labels} large locale={locale} scale={scale} />
        {headline.updating ? (
          <Badge className="w-fit" data-slot="rating-updating" variant="outline">
            {labels.updating}
          </Badge>
        ) : null}
        {state === 'published' ? (
          <Distribution aggregate={headline} labels={labels} locale={locale} scale={scale} />
        ) : state === 'withheld' ? (
          <p className="text-muted-foreground text-sm" data-slot="rating-distribution-hidden">
            {fill(labels.distributionHidden, { threshold: number(locale, headline.threshold, [0, 0]) })}
          </p>
        ) : null}
      </div>

      {aside ? (
        <div className="flex flex-col gap-0.5 border-t pt-2" data-slot="rating-global">
          <Figure aggregate={aside} labels={labels} locale={locale} scale={scale} />
        </div>
      ) : null}

      {own === null ? null : (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm" data-slot="rating-own">
          <span className="font-medium">{labels.own}</span>
          <span className="font-semibold tabular-nums">{number(locale, own / scale.unitsPerPoint, [0, 1])}</span>
          <span className="text-muted-foreground">{labels.ownHint}</span>
        </p>
      )}

      {others.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-slot="rating-populations">
          <p className="font-medium text-sm" id={`${id}-others`}>
            {labels.others}
          </p>
          <ul aria-labelledby={`${id}-others`} className="flex flex-col divide-y">
            {shown.map((other) => (
              <li
                className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                key={other.population.id}
              >
                <Figure aggregate={other} labels={labels} locale={locale} scale={scale} />
              </li>
            ))}
          </ul>
          {others.length > visible ? (
            <Button
              aria-expanded={expanded}
              className="w-fit"
              onClick={() => setExpanded((open) => !open)}
              size="sm"
              variant="link"
            >
              {expanded
                ? labels.showFewer
                : fill(labels.showMore, { count: number(locale, others.length - visible, [0, 0]) })}
            </Button>
          ) : null}
        </div>
      )}

      {imported.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-slot="rating-imported">
          <p className="font-medium text-sm" id={`${id}-imported`}>
            {labels.imported}
          </p>
          <p className="text-muted-foreground text-sm">{labels.importedNote}</p>
          <ul aria-labelledby={`${id}-imported`} className="flex flex-col divide-y">
            {imported.map((entry) => (
              <li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0" key={entry.source}>
                <span className="font-medium text-sm [overflow-wrap:anywhere]">{entry.source}</span>
                <span className="text-muted-foreground text-sm">
                  {fill(labels.importedLine, {
                    score: number(locale, entry.mean, [1, 2]),
                    max: number(locale, entry.scale.maximum, [0, 1]),
                    count: number(locale, entry.count, [0, 0]),
                    date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
                      new Date(entry.asOf),
                    ),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export interface RatingInputLabels {
  /** Names the control and the readout. */
  label: string;
  /** Spoken after the value; `{max}` is the top of the scale. */
  outOf: string;
  unrated: string;
  clear: string;
  /** Announced when saving fails. */
  failed: string;
}

export const ratingInputLabels: RatingInputLabels = {
  label: 'Your rating',
  outOf: 'out of {max}',
  unrated: 'Not rated',
  clear: 'Clear rating',
  failed: 'Your rating could not be saved.',
};

export interface RatingInputProps {
  scale: RatingScale;
  /** The reader's current vote in stored units, or null when they have none. */
  value: number | null;
  /**
   * Persists the reader's one vote, or clears it with null. Resolve when it is saved. Reject to roll the control
   * back. A change made while one is saving waits, and only the latest waiting change is sent.
   */
  onChange: (units: number | null) => Promise<void>;
  locale: string;
  labels?: Partial<RatingInputLabels>;
  disabled?: boolean;
}

interface Choice {
  units: number | null;
}

/**
 * The control that writes the reader's one vote: a slider over the question's scale and a clear button. It shows the
 * vote at once, rolls back with an announced message when saving fails, and is the same on every surface.
 */
export function RatingInput(props: RatingInputProps) {
  const { scale, locale } = props;
  const labels = resolveLabels(ratingInputLabels, props.labels);
  const id = useId();
  const propsRef = useRef(props);
  propsRef.current = props;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const queued = useRef<Choice | null>(null);

  // Drop the optimistic choice once the controlled value echoes it and nothing is queued.
  useEffect(() => {
    if (!busy && choice !== null && choice.units === props.value) setChoice(null);
  }, [busy, choice, props.value]);

  const save = async (units: number | null) => {
    queued.current = { units };
    setChoice({ units });
    setDraft(null);
    setFailure(null);
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      while (queued.current !== null) {
        const next = queued.current;
        queued.current = null;
        try {
          await propsRef.current.onChange(next.units);
        } catch {
          queued.current = null;
          setChoice(null);
          setFailure(labelsRef.current.failed);
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const units = draft ?? (choice === null ? props.value : choice.units);
  const max = number(locale, topOf(scale), [0, 1]);
  const display = (value: number) => number(locale, value / scale.unitsPerPoint, [0, 1]);
  const middle = Math.round((scale.minimum + scale.maximum) / 2);
  const text = units === null ? labels.unrated : `${display(units)} ${fill(labels.outOf, { max })}`;

  return (
    <div
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-2"
      data-slot="rating-input"
      data-state={units === null ? 'unrated' : 'rated'}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium text-sm" id={`${id}-label`}>
          {labels.label}
        </span>
        <div className="flex items-center gap-2">
          <output
            aria-live="polite"
            className={cn('font-semibold tabular-nums', units === null && 'font-normal text-muted-foreground text-sm')}
            data-slot="rating-value"
            id={`${id}-value`}
          >
            {text}
          </output>
          <Button
            disabled={props.disabled || units === null}
            onClick={() => void save(null)}
            size="sm"
            variant="outline"
          >
            {labels.clear}
          </Button>
        </div>
      </div>
      <Slider
        // Unrated, the slider's name carries the readout, because its resting position is not a vote.
        aria-labelledby={units === null ? `${id}-label ${id}-value` : `${id}-label`}
        className={cn(
          '[&>div]:min-h-11 **:data-[slot=slider-thumb]:size-5 **:data-[slot=slider-thumb]:ring-2 **:data-[slot=slider-thumb]:ring-primary',
          units === null &&
            '**:data-[slot=slider-range]:opacity-0 **:data-[slot=slider-thumb]:bg-muted **:data-[slot=slider-thumb]:ring-primary/50',
        )}
        disabled={props.disabled}
        locale={locale}
        // The slider works in displayed points, so assistive technology reads 8.5 rather than the stored 17.
        max={topOf(scale)}
        min={scale.minimum / scale.unitsPerPoint}
        onValueChange={(next) => setDraft(toUnits(next, scale))}
        onValueCommitted={(next) => void save(toUnits(next, scale))}
        step={1 / scale.unitsPerPoint}
        value={[(units ?? middle) / scale.unitsPerPoint]}
      />
      <div aria-hidden="true" className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{display(scale.minimum)}</span>
        <span>{display(scale.maximum)}</span>
      </div>
      {failure === null ? null : (
        <p className="text-sm" role="status">
          {failure}
        </p>
      )}
    </div>
  );
}
