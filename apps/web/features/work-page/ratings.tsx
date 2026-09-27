import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { MessageCircleQuestionIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { formatNumber, formatShare } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { idOf, workHref } from './route.ts';
import { ScopeOffer, type ScopeView, scopeName } from './scope-bar.tsx';
import type { Loaded, RatingRead, RatingSummary } from './types.ts';

export const RATINGS_REGION = 'work-ratings';

function Distribution({ summary, locale, label }: { summary: RatingSummary; locale: UiLocale; label: string }) {
  const { scale } = summary;
  if (!scale) return null;
  const counts = new Map(summary.distribution.map(bucket => [bucket.value, bucket.count]));
  const values = Array.from({ length: scale.max - scale.min + 1 }, (_, index) => scale.max - index);
  const top = Math.max(1, ...counts.values());
  return <ol aria-label={label} className="grid gap-1.5">
    {values.map(value => {
      const count = counts.get(value) ?? 0;
      return <li key={value} className="grid grid-cols-[1.5rem_minmax(0,1fr)_6.5rem] items-center gap-3 text-sm">
        <span className="text-end font-medium tabular-nums">{value}</span>
        <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${(count / top) * 100}%` }} /></span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatNumber(count, locale)} ({formatShare(count, summary.count, locale)})</span>
      </li>;
    })}
  </ol>;
}

function EmptyScope({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="grid justify-items-start gap-3 rounded-xl border border-border/80 border-dashed px-4 py-5">
    <p className="font-medium">{title}</p>
    {children}
  </div>;
}

/**
 * A scope's rating summary in the Goodreads shape: the question it answers,
 * the mean on its actual scale, the count and the full distribution. Empty
 * and question-less scopes say which scope they are and offer the neighbour.
 */
export function RatingSummaryRegion({ ratings, view, locale, messages }: {
  ratings: Loaded<RatingRead>; view: ScopeView; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = scopeName(view, messages, locale);
  const badge = <Badge variant="outline" className="bg-card">{name}</Badge>;
  const here = workHref(view.workRef, 'overview', view.scope);
  if (!ratings.ok) {
    const step = ratings.failure === 'sign-in' ? { title: t.mineSignIn, label: t.signIn, path: '/sign-in' }
      : ratings.failure === 'identity' ? { title: t.mineIdentity, label: t.chooseIdentity, path: '/identity' } : null;
    return <Region id={RATINGS_REGION} title={t.ratings} aside={badge}>
      {step ? <EmptyScope title={step.title}>
        <Link href={`${step.path}?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: 'sm' })}>
          {step.label}</Link>
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
    body = <p className="font-medium text-lg">
      {t.yourRating({ value: formatNumber(own, locale), max: formatNumber(summary.scale.max, locale) })}</p>;
  } else {
    const mean = formatNumber(summary.mean ?? 0, locale, 2);
    body = <div className="grid gap-5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
      <div className="grid gap-1">
        <p className="font-semibold text-4xl tabular-nums tracking-tight">{mean}
          <span className="sr-only"> — {t.average({ mean, max: formatNumber(summary.scale.max, locale) })}</span>
          <span aria-hidden="true" className="ms-1 font-normal text-base text-muted-foreground">
            / {formatNumber(summary.scale.max, locale)}</span></p>
        <p className="text-muted-foreground text-sm">{t.ratingCount(summary.count)}</p>
      </div>
      <Distribution summary={summary} locale={locale} label={t.distribution} />
    </div>;
  }
  return <Region id={RATINGS_REGION} title={t.ratings} aside={badge}>
    {context ? <p className="flex items-start gap-2 text-sm">
      <MessageCircleQuestionIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span><span className="text-muted-foreground">{t.context}: </span>
        <span lang={context.language}>{context.question}</span>
        <span className="text-muted-foreground"> · {t.scale({ min: formatNumber(context.scale.min, locale),
          max: formatNumber(context.scale.max, locale) })}</span></span>
    </p> : null}
    {body}
    {contexts.length > 1 ? <nav aria-labelledby={`${RATINGS_REGION}-questions`}
      className="flex flex-wrap items-center gap-1.5 border-border/60 border-t pt-3">
      <span id={`${RATINGS_REGION}-questions`} className="me-1 text-muted-foreground text-xs">{t.otherQuestions}</span>
      {contexts.map(item => {
        const current = item.context === context?.context;
        return <Link key={item.context} lang={item.language} aria-current={current ? 'true' : undefined}
          href={workHref(view.workRef, 'overview', scope, { context: idOf(item.context) ?? undefined })}
          className={cn(buttonVariants({ size: 'xs', variant: current ? 'soft' : 'ghost' }), 'max-w-full truncate')}>
          {item.question}</Link>;
      })}
    </nav> : null}
  </Region>;
}
