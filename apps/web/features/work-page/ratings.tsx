import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { ratingsUntilMean, StarMeter } from '../catalogue/rating.tsx';
import { messages as shelfMessages } from '../catalogue/messages.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { bars, figuresOfRating, scoreView, type Figures } from '../scoped-rating/score.ts';
import { formatNumber, formatShare } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, workHref } from './route.ts';
import { ScopeOffer, type ScopeView } from './scope-bar.tsx';
import { scopeName } from './scope-labels.ts';
import type { Loaded, RatingRead, StatCount, WorkStats } from './types.ts';

export const RATINGS_REGION = 'work-ratings';
/** `REVIEWS_REGION` in reviews.tsx, a client module whose constants a server component can't import. */
export const REVIEWS_ANCHOR = 'work-reviews';

type Translation = ReturnType<typeof materializeData<WorkPageMessages>>;

/** "5 reviews", or "10,000+ reviews" once there are more than Main counts. */
function counted(
  count: StatCount,
  exact: (value: number) => string,
  atLeast: (values: { count: string }) => string,
  locale: UiLocale,
) {
  return count.kind === 'exact'
    ? exact(count.value)
    : atLeast({ count: formatNumber(count.value, locale) });
}

/** What the one rating figure and its histogram draw with: the Work page's words, or another feature's carrying the same keys. */
export type RatingFigureMessages = Pick<
  WorkPageMessages,
  'ratingCount' | 'average' | 'distribution' | 'stars' | 'barCount'
>;

/**
 * Goodreads' distribution: "5 stars", a bar in the star color, the count and its share, or a strip of columns where
 * space is short. The one histogram of every score: nothing is drawn where nobody has rated, never a chart of zeros.
 */
export function Distribution({
  figures,
  locale,
  messages,
  compact = false,
}: {
  figures: Figures;
  locale: UiLocale;
  messages: RatingFigureMessages;
  compact?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const rows = bars(figures);
  if (!rows) return null;
  const label = (value: number, count: number) =>
    `${t.stars(value)}: ${t.barCount({ count: formatNumber(count, locale), share: formatShare(count, figures.count, locale) })}`;
  if (compact) {
    const peak = Math.max(...rows.map((row) => row.count), 1);
    return (
      <ol data-rating-strip aria-label={t.distribution} className="flex h-2.5 max-w-48 gap-0.5">
        {rows.map(({ value, count }) => (
          <li
            key={value}
            className="relative flex-1 rounded-xs bg-muted"
            title={label(value, count)}
          >
            <span className="sr-only">{label(value, count)}</span>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 rounded-xs bg-rating/75"
              style={{ height: `${(count / peak) * 100}%` }}
            />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol aria-label={t.distribution} className="grid gap-2">
      {rows.map(({ value, count }) => (
        <li
          key={value}
          className="grid grid-cols-[3.75rem_minmax(0,1fr)_7rem] items-center gap-3 text-sm"
        >
          <span className="whitespace-nowrap font-medium">{t.stars(value)}</span>
          <span aria-hidden="true" className="h-3 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-rating"
              style={{ width: `${(count / figures.count) * 100}%` }}
            />
          </span>
          <span className="text-muted-foreground tabular-nums">
            {t.barCount({
              count: formatNumber(count, locale),
              share: formatShare(count, figures.count, locale),
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EmptyScope({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-3 rounded-2xl bg-muted/60 px-5 py-4">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

const countLink = cn(
  'rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline',
  'focus-visible:ring-2 focus-visible:ring-ring',
);

/**
 * The one score figure, only as far as it is true. A mean shows as stars and the number large in the Work-title face,
 * then the counts ("1,287 ratings · 214 reviews"); below the question's display threshold the count shows with how
 * many more ratings reveal the average; with no ratings it shows `empty` or nothing. Never a zero or a placeholder
 * star. `sm` sets it out for a row, `md` and `lg` for a heading.
 */
export function Mean({
  figures,
  locale,
  messages,
  size = 'lg',
  href,
  reviews,
  empty,
  className,
}: {
  figures: Figures;
  locale: UiLocale;
  messages: RatingFigureMessages;
  size?: 'sm' | 'md' | 'lg';
  href?: string;
  /** The reviews answering the same question, beside the ratings count. */
  reviews?: ReactNode;
  /** What to say where nobody has rated; omitted, nothing is drawn. */
  empty?: string;
  className?: string;
}) {
  const t = materializeData(messages, { locale });
  const view = scoreView(figures);
  if (view.kind === 'none')
    return empty ? (
      <p data-rating-mean="none" className={cn('text-muted-foreground text-sm', className)}>
        {empty}
      </p>
    ) : null;
  const { max } = figures;
  const mean = view.kind === 'shown' ? formatNumber(view.mean, locale, 2) : null;
  const count = t.ratingCount(figures.count);
  const remaining =
    view.kind === 'withheld'
      ? ratingsUntilMean(figures.count, figures.displayThreshold, locale)
      : null;
  return (
    <div
      data-rating-mean={view.kind}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}
    >
      {view.kind === 'shown' ? (
        <>
          <StarMeter
            mean={view.mean}
            max={max}
            className={size === 'lg' ? 'text-[1.75rem]' : size === 'md' ? 'text-2xl' : 'text-lg'}
          />
          <p
            className={cn(
              'font-semibold tabular-nums tracking-tight',
              size === 'lg' && 'font-work-title text-4xl',
              size === 'md' && 'font-work-title text-3xl',
              size === 'sm' && 'text-base',
            )}
          >
            {mean}
            <span className="sr-only">
              {' '}
              — {t.average({ mean: mean!, max: formatNumber(max, locale) })}
            </span>
            {max === 5 ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  'ms-1 font-normal font-sans text-muted-foreground',
                  size === 'sm' ? 'text-sm' : 'text-base',
                )}
              >
                / {formatNumber(max, locale)}
              </span>
            )}
          </p>
        </>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
        {href ? (
          <Link href={href} className={countLink}>
            {count}
          </Link>
        ) : (
          count
        )}
        {reviews ? (
          <>
            <span aria-hidden="true">·</span>
            {reviews}
          </>
        ) : null}
      </p>
      {remaining ? <p className="w-full text-muted-foreground text-sm">{remaining}</p> : null}
    </div>
  );
}

/** "3 people are currently reading", as Goodreads counts them, from public libraries only. */
function ReadingNow({ count, locale, t }: { count: StatCount; locale: UiLocale; t: Translation }) {
  if (!count.value) return null;
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
      <UsersRoundIcon aria-hidden="true" className="size-4 shrink-0" />
      {counted(count, t.readingNow, t.readingNowAtLeast, locale)}
    </p>
  );
}

function WantToRead({ count, locale }: { count: StatCount; locale: UiLocale }) {
  if (!count.value) return null;
  const shelf = materializeData(shelfMessages[locale], { locale });
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
      <UsersRoundIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="tabular-nums">
        {formatNumber(count.value, locale)}
        {count.kind === 'lower-bound' ? '+' : ''}
      </span>
      {shelf.wantToRead}
    </p>
  );
}

/**
 * The numbers under the title, as Goodreads heads a book page: everyone's
 * mean for the Work's first rating question with its ratings and reviews,
 * each linking down to its section, then how many people are reading it now.
 * Says nothing of a read that failed; the sections below say so and offer a
 * retry, and numbers Main could not count are left out.
 */
export function RatingLine({
  ratings,
  stats,
  locale,
  messages,
}: {
  ratings: Loaded<RatingRead>;
  /** Readers and reviews counted from public libraries, for the same question as `ratings`. */
  stats?: Loaded<WorkStats>;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const counts = stats?.ok ? stats.data : null;
  const reading = counts ? <ReadingNow count={counts.reading} locale={locale} t={t} /> : null;
  const want = counts ? <WantToRead count={counts.wantToRead} locale={locale} /> : null;
  const group = 'grid justify-items-start gap-1.5';
  if (!ratings.ok || ratings.data.summary.status !== 'available' || !ratings.data.summary.scale)
    return (
      <>
        {reading}
        {want}
      </>
    );
  const { summary } = ratings.data;
  const figures = figuresOfRating(summary);
  if (!figures?.count) {
    return (
      <div className={group}>
        <p className="text-muted-foreground text-sm">{t.noRatingsGlobal}</p>
        {reading}
        {want}
      </div>
    );
  }
  const reviews = counts?.reviews?.value ? (
    <Link href={`#${REVIEWS_ANCHOR}`} className={countLink}>
      {counted(counts.reviews, t.reviewCount, t.reviewCountAtLeast, locale)}
    </Link>
  ) : null;
  return (
    <div className={group}>
      <Mean
        figures={figures}
        locale={locale}
        messages={messages}
        size="md"
        href={`#${RATINGS_REGION}`}
        reviews={reviews}
        className="justify-start"
      />
      {figures.mean === null ? (
        <Distribution figures={figures} locale={locale} messages={messages} />
      ) : null}
      {reading}
      {want}
    </div>
  );
}

/**
 * A scope's ratings in the Goodreads shape: the mean in stars and numbers,
 * the count and the full distribution. Whose ratings they are is switched
 * beside the heading; a second rating question is offered only when the
 * scope has one. Empty and question-less scopes offer the neighbour.
 */
export function RatingSummaryRegion({
  ratings,
  view,
  scopeBar,
  locale,
  messages,
}: {
  ratings: Loaded<RatingRead>;
  view: ScopeView;
  scopeBar?: ReactNode;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const here = workHref(view.workRef, 'overview', view.scope);
  if (!ratings.ok) {
    const back = localizedPath(here, locale);
    const step =
      ratings.failure === 'sign-in'
        ? { title: t.mineSignIn, label: t.signIn, href: signInPath(back) }
        : ratings.failure === 'identity'
          ? {
              title: t.mineIdentity,
              label: t.chooseIdentity,
              href: localizedPath(`/identity?next=${encodeURIComponent(back)}`, locale),
            }
          : null;
    return (
      <Region id={RATINGS_REGION} title={t.ratings} aside={scopeBar}>
        {step ? (
          <EmptyScope title={step.title}>
            <Link href={step.href} className={buttonVariants({ size: 'sm' })}>
              {step.label}
            </Link>
          </EmptyScope>
        ) : (
          <RegionFailure
            title={t.ratingsUnavailable}
            failure={ratings.failure}
            messages={messages}
          />
        )}
      </Region>
    );
  }
  const { summary, context, contexts } = ratings.data;
  const { scope } = view;
  const offer = <ScopeOffer view={view} locale={locale} messages={messages} />;
  let body: ReactNode;
  if (summary.status === 'no-context' || !summary.scale) {
    body = (
      <EmptyScope
        title={
          scope.kind === 'global'
            ? t.noQuestionGlobal
            : scope.kind === 'mine'
              ? t.noQuestionMine
              : t.noQuestionRealm({ realm: name })
        }
      >
        {offer}
      </EmptyScope>
    );
  } else if (summary.count === 0) {
    body = (
      <EmptyScope
        title={
          scope.kind === 'global'
            ? t.noRatingsGlobal
            : scope.kind === 'mine'
              ? t.noRatingMine
              : t.noRatingsRealm({ realm: name })
        }
      >
        {offer}
      </EmptyScope>
    );
  } else if (scope.kind === 'mine') {
    const own = summary.distribution.find((bucket) => bucket.count > 0)?.value ?? summary.mean ?? 0;
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <StarMeter mean={own} max={summary.scale.max} className="text-2xl" />
        <p className="font-medium text-lg">
          {t.yourRating({
            value: formatNumber(own, locale),
            max: formatNumber(summary.scale.max, locale),
          })}
        </p>
      </div>
    );
  } else {
    const figures = figuresOfRating(summary)!;
    body = (
      <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
        <Mean figures={figures} locale={locale} messages={messages} />
        <Distribution figures={figures} locale={locale} messages={messages} />
      </div>
    );
  }
  // A single question is the scope's only one; naming it would expose the model, not help the reader.
  const questions =
    contexts.length > 1 ? (
      <nav
        aria-labelledby={`${RATINGS_REGION}-questions`}
        className="flex flex-wrap items-center gap-1.5"
      >
        <span id={`${RATINGS_REGION}-questions`} className="me-1 text-muted-foreground text-xs">
          {t.otherQuestions}
        </span>
        {contexts.map((item) => {
          const current = item.context === context?.context;
          return (
            <Link
              key={item.context}
              lang={item.language}
              aria-current={current ? 'true' : undefined}
              href={workHref(view.workRef, 'overview', scope, {
                context: idOf(item.context) ?? undefined,
              })}
              className={cn(
                buttonVariants({ size: 'xs', variant: current ? 'soft' : 'ghost' }),
                'max-w-full truncate',
              )}
            >
              {item.question}
            </Link>
          );
        })}
      </nav>
    ) : null;
  // What the numbers mean, always: the question asked, who answered, the scale and how many.
  const basis =
    summary.status === 'available' && summary.scale && context ? (
      <p data-rating-basis className="flex flex-wrap gap-x-2 text-muted-foreground text-sm">
        <span lang={context.language}>{context.question}</span>
        <span aria-hidden="true">·</span>
        <span>{t.ratingPopulation({ who: name })}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t.ratingScaleRange({
            min: formatNumber(summary.scale.min, locale),
            max: formatNumber(summary.scale.max, locale),
          })}
        </span>
        <span aria-hidden="true">·</span>
        <span>{t.ratingCount(summary.count)}</span>
      </p>
    ) : null;
  return (
    <Region id={RATINGS_REGION} title={t.ratings} aside={scopeBar}>
      {body}
      {basis}
      {questions}
    </Region>
  );
}

/**
 * The ratings of any one resource (a release, a character, a Work) in the shape
 * the Work page gives a scope: the mean, the count and the distribution of the
 * first question Main lists. `subject` says what was rated ("Ratings for this
 * release"); it is the caller's words, from the registry. Reading only: the
 * stars a reader writes belong to the Work's own page.
 */
export function TargetRatingsRegion({
  ratings,
  subject,
  none,
  locale,
  messages,
}: {
  ratings: Loaded<RatingRead>;
  subject: string;
  none: string;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  if (!ratings.ok) {
    return (
      <Region id={RATINGS_REGION} title={t.ratings}>
        <RegionFailure title={t.ratingsUnavailable} failure={ratings.failure} messages={messages} />
      </Region>
    );
  }
  const { summary } = ratings.data;
  const figures = figuresOfRating(summary);
  return (
    <Region id={RATINGS_REGION} title={t.ratings}>
      <p className="text-muted-foreground text-sm">{subject}</p>
      {ratings.data.context ? (
        <p
          lang={ratings.data.context.displayQuestion.language}
          dir={ratings.data.context.displayQuestion.direction}
          className="text-muted-foreground text-sm"
        >
          {ratings.data.context.displayQuestion.value}
        </p>
      ) : null}
      {!figures?.count ? (
        <EmptyScope title={figures ? t.noRatingsGlobal : none} />
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
          <Mean figures={figures} locale={locale} messages={messages} />
          <Distribution figures={figures} locale={locale} messages={messages} />
        </div>
      )}
    </Region>
  );
}
