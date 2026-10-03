import { LocalizedText } from '@rezics/ui/localized-text';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { authorHref } from '../author/route.ts';
import { authorSeparator } from '../catalogue/work.ts';
import { contentText } from '../language/untagged.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { AgentCreditPage, CreditPage, Loaded } from './types.ts';

/** Main keeps Open Library's author path (`/authors/OL1A`); the page shows and links the ID. */
export const openLibraryAuthorKey = (key: string) => key.replace(/^\/authors\//, '');

const authorLink = 'rounded-sm outline-none decoration-1 underline-offset-4 hover:underline focus-visible:ring-2 '
  + 'focus-visible:ring-ring';

/**
 * Who made the Work, as Goodreads sets it under the title: authors in the
 * Work-title face, then "Translated by" and "Edited by" in smaller type.
 * Native authors link to their profile; authors an import brought from Open
 * Library are named as Open Library lists them and link to their REZICS page. A Work with
 * no credit shows none, rather than a line about credits. When one of the two
 * reads fails, the other still shows and the gap is said.
 */
export function WorkCredits({ agentCredits, credits, locale, messages }: {
  agentCredits: Loaded<AgentCreditPage>; credits: Loaded<CreditPage>; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const failure = !agentCredits.ok || !credits.ok;
  const retry = failure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
    <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
    <span className="text-destructive-foreground">
      {!agentCredits.ok && !credits.ok ? t.creditsUnavailable : t.someCreditsUnavailable}</span>
    <RetryButton label={t.retry} pendingLabel={t.retrying} />
  </div> : null;
  const native = agentCredits.ok ? agentCredits.data.items : [];
  const external = credits.ok ? [...credits.data.items].sort((a, b) => a.ordinal - b.ordinal) : [];
  if (!native.length && !external.length) return retry;
  const more = (agentCredits.ok && agentCredits.data.nextCursor) || (credits.ok && credits.data.nextCursor);
  const authors = native.filter(credit => credit.role === 'author');
  const separator = authorSeparator([...authors.map(credit => credit.displayName),
    ...external.map(credit => credit.displayName ?? credit.key)]);
  const others = (['translator', 'editor'] as const).map(role => ({ role,
    people: native.filter(credit => credit.role === role) })).filter(group => group.people.length);
  // Start-aligned beside the cover, as the title is; a long name wraps instead of widening a phone's column.
  return <div className="grid gap-1.5">
    {authors.length || external.length ? <p className="flex flex-wrap items-baseline justify-start gap-y-1
      font-work-title text-foreground/85 text-lg sm:text-2xl">
      <span className="sr-only">{authors.length + external.length > 1 ? t.authors : t.author}: </span>
      {authors.map((credit, index) => <span key={credit.id} className="min-w-0 max-w-full [overflow-wrap:anywhere]">{index ? separator : null}
        <Link href={authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })}
        title={credit.handle ? `@${credit.handle}` : undefined}
        className={authorLink}><LocalizedText text={contentText(credit.displayName)} /></Link></span>)}
      {external.map((credit, index) => {
        const key = openLibraryAuthorKey(credit.key);
        return <span key={credit.id} className="min-w-0 max-w-full [overflow-wrap:anywhere]">{authors.length + index ? separator : null}
          <Link href={authorHref({ kind: 'external', key: credit.key })}
          title={credit.displayName ? t.openLibraryListed : undefined}
          className={cn(authorLink, !credit.displayName && 'font-sans font-medium text-primary text-sm')}>
          {credit.displayName ? <LocalizedText text={contentText(credit.displayName)} /> : t.openLibraryAuthor({ key })}</Link></span>;
      })}
    </p> : null}
    {others.length ? <p className="flex flex-wrap justify-start gap-x-4 gap-y-1 text-muted-foreground text-sm">
      {others.map(group => <span key={group.role}>
        {group.role === 'translator' ? t.translatedBy : t.editedBy}{' '}
        {group.people.map((credit, index) => <span key={credit.id}>{index ? ', ' : ''}
          <Link href={authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })}
            title={credit.handle ? `@${credit.handle}` : undefined}
            className={cn(authorLink, 'font-medium text-foreground')}>
            <LocalizedText text={contentText(credit.displayName)} /></Link></span>)}
      </span>)}
    </p> : null}
    {more ? <p className="text-muted-foreground text-xs">{t.moreCredits}</p> : null}
    {retry}
  </div>;
}

export function WorkCreditsSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-2">
    <Skeleton className="h-5 w-16 rounded-md" /><Skeleton className="h-5 w-40 rounded-md" />
  </div>;
}
