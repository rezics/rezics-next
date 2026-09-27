import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { StarMeter } from '../catalogue/rating.tsx';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { formatNumber, formatShare } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, workHref } from './route.ts';
import { ScopeOffer, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Loaded, RatingRead, RatingSummary } from './types.ts';

export const RATINGS_REGION = 'work-ratings';

/** Goodreads' distribution: "5 stars", a bar in the star color, the count and its share. */
function Distribution({ summary, locale, messages }: { summary: RatingSummary; locale: UiLocale; messages: WorkPageMessages }) {
  const t = materializeData(messages, { locale });
  const { scale } = summary;
  if (!scale) return null;
  const counts = new Map(summary.distribution.map(bucket => [bucket.value, bucket.count]));
  const values = Array.from({ length: scale.max - scale.min + 1 }, (_, index) => scale.max - index);
  return <ol aria-label={t.distribution} className="grid gap-2">
    {values.map(value => {
      const count = counts.get(value) ?? 0;
      return <li key={value} className="grid grid-cols-[3.75rem_minmax(0,1fr)_7rem] items-center gap-3 text-sm">
        <span className="whitespace-nowrap font-medium">{t.stars(value)}</span>
        <span aria-hidden="true" className="h-3 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-rating"
            style={{ width: `${summary.count ? (count / summary.count) * 100 : 0}%` }} /></span>
        <span className="text-muted-foreground tabular-nums">
          {t.barCount({ count: formatNumber(count, locale), share: formatShare(count, summary.count, locale) })}</span>
      </li>;
    })}
  </ol>;
}

function EmptyScope({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="grid justify-items-start gap-3 rounded-2xl bg-muted/60 px-5 py-4">
    <p className="font-medium">{title}</p>
    {children}
  </div>;
}

/** The mean as Goodreads sets it: stars, the number large in the Work-title face, the count beside. */
function Mean({ summary, locale, messages, size = 'lg', href, className }: {
  summary: RatingSummary; locale: UiLocale; messages: WorkPageMessages; size?: 'md' | 'lg'; href?: string;
  className?: string;
}) {
  const t = materializeData(messages, { locale });
  const max = summary.scale?.max ?? 5;
  const mean = formatNumber(summary.mean ?? 0, locale, 2);
  const count = t.ratingCount(summary.count);
  return <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
    <StarMeter mean={summary.mean ?? 0} max={max} className={size === 'lg' ? 'text-[1.75rem]' : 'text-2xl'} />
    <p className={cn('font-semibold font-work-title tabular-nums tracking-tight', size === 'lg' ? 'text-4xl' : 'text-3xl')}>
      {mean}<span className="sr-only"> — {t.average({ mean, max: formatNumber(max, locale) })}</span>
      {max === 5 ? null : <span aria-hidden="true" className="ms-1 font-normal font-sans text-base text-muted-foreground">
        / {formatNumber(max, locale)}</span>}</p>
    {href ? <Link href={href} className="rounded-sm text-muted-foreground text-sm underline-offset-4 outline-none
      hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">{count}</Link>
      : <p className="text-muted-foreground text-sm">{count}</p>}
  </div>;
}

/**
 * The rating summary under the title: everyone's mean for the Work's first
 * rating question, linking down to the full distribution. Says nothing when
 * the read failed; the Ratings section below says so and offers a retry.
 */
export function RatingLine({ ratings, locale, messages }: {
  ratings: Loaded<RatingRead>; locale: UiLocale; messages: WorkPageMessages;
}) {
  if (!ratings.ok || ratings.data.summary.status !== 'available' || !ratings.data.summary.scale) return null;
  const { summary } = ratings.data;
  if (!summary.count) return <p className="text-muted-foreground text-sm">{messages.noRatingsGlobal}</p>;
  return <Mean summary={summary} locale={locale} messages={messages} size="md" href={`#${RATINGS_REGION}`}
    className="justify-center lg:justify-start" />;
}

/**
 * A scope's ratings in the Goodreads shape: the mean in stars and numbers,
 * the count and the full distribution. Whose ratings they are is switched
 * beside the heading; a second rating question is offered only when the
 * scope has one. Empty and question-less scopes offer the neighbour.
 */
export function RatingSummaryRegion({ ratings, view, scopeBar, locale, messages }: {
  ratings: Loaded<RatingRead>; view: ScopeView; scopeBar?: ReactNode; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const here = workHref(view.workRef, 'overview', view.scope);
  if (!ratings.ok) {
    const back = localizedPath(here, locale);
    const step = ratings.failure === 'sign-in' ? { title: t.mineSignIn, label: t.signIn, href: signInPath(back) }
      : ratings.failure === 'identity' ? { title: t.mineIdentity, label: t.chooseIdentity,
        href: localizedPath(`/identity?next=${encodeURIComponent(back)}`, locale) } : null;
    return <Region id={RATINGS_REGION} title={t.ratings} aside={scopeBar}>
      {step ? <EmptyScope title={step.title}>
        <Link href={step.href} className={buttonVariants({ size: 'sm' })}>{step.label}</Link>
      </EmptyScope> : <RegionFailure title={t.ratingsUnavailable} failure={ratings.failure} messages={messages} />}
    </Region>;
  }
  const { summary, context, contexts } = ratings.data;
  const { scope } = view;
  const offer = <ScopeOffer view={view} locale={locale} messages={messages} />;
  let body: ReactNode;
  if (summary.status === 'no-context' || !summary.scale) {
    body = <EmptyScope title={scope.kind === 'global' ? t.noQuestionGlobal : scope.kind === 'mine' ? t.noQuestionMine
      : t.noQuestionRealm({ realm: name })}>{offer}</EmptyScope>;
  } else if (summary.count === 0) {
    body = <EmptyScope title={scope.kind === 'global' ? t.noRatingsGlobal : scope.kind === 'mine' ? t.noRatingMine
      : t.noRatingsRealm({ realm: name })}>{offer}</EmptyScope>;
  } else if (scope.kind === 'mine') {
    const own = summary.distribution.find(bucket => bucket.count > 0)?.value ?? summary.mean ?? 0;
    body = <div className="flex flex-wrap items-center gap-3">
      <StarMeter mean={own} max={summary.scale.max} className="text-2xl" />
      <p className="font-medium text-lg">
        {t.yourRating({ value: formatNumber(own, locale), max: formatNumber(summary.scale.max, locale) })}</p>
    </div>;
  } else {
    body = <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:items-center">
      <Mean summary={summary} locale={locale} messages={messages} />
      <Distribution summary={summary} locale={locale} messages={messages} />
    </div>;
  }
  // A single question is the scope's only one; naming it would expose the model, not help the reader.
  const questions = contexts.length > 1 ? <nav aria-labelledby={`${RATINGS_REGION}-questions`}
    className="flex flex-wrap items-center gap-1.5">
    <span id={`${RATINGS_REGION}-questions`} className="me-1 text-muted-foreground text-xs">{t.otherQuestions}</span>
    {contexts.map(item => {
      const current = item.context === context?.context;
      return <Link key={item.context} lang={item.language} aria-current={current ? 'true' : undefined}
        href={workHref(view.workRef, 'overview', scope, { context: idOf(item.context) ?? undefined })}
        className={cn(buttonVariants({ size: 'xs', variant: current ? 'soft' : 'ghost' }), 'max-w-full truncate')}>
        {item.question}</Link>;
    })}
  </nav> : null;
  return <Region id={RATINGS_REGION} title={t.ratings} aside={scopeBar}>
    {body}
    {questions}
  </Region>;
}
