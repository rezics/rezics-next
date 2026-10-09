import { LocalizedText } from '@rezics/ui/localized-text';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { authorHref } from '../author/route.ts';
import { type CatalogueAuthor, authorSeparator } from '../catalogue/work.ts';
import { contentText } from '../language/untagged.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RetryButton } from './retry-button.tsx';
import type { AgentCreditPage, Credit, CreditPage, Loaded } from './types.ts';

/** Main keeps Open Library's author path (`/authors/OL1A`); the page shows and links the ID. */
export const openLibraryAuthorKey = (key: string) => key.replace(/^\/authors\//, '');

/**
 * Authors for the generated cover. Only an author credit is a name: a native
 * author, or an author the work-credits read brought from outside. Neither
 * read names the account that created or imported the Work, and an empty pair
 * of reads stays empty rather than inventing one. `unnamed` stands in when an
 * imported author has a key and no display name.
 */
const importedAuthor = (credit: Credit): credit is Credit & { key: string; ordinal: number } =>
  credit.participantKind === 'external-reference' && credit.role === 'author'
  && typeof credit.key === 'string' && typeof credit.ordinal === 'number';

export function coverAuthors(agentCredits: Loaded<AgentCreditPage>, credits: Loaded<CreditPage>,
  unnamed: (key: string) => string): CatalogueAuthor[] {
  const native = agentCredits.ok ? agentCredits.data.items.filter(credit => credit.role === 'author') : [];
  const external = credits.ok ? credits.data.items.filter(importedAuthor).sort((a, b) => a.ordinal - b.ordinal) : [];
  return [
    ...native.map(credit => ({ name: credit.displayName,
      href: authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent }) })),
    ...external.map(credit => ({
      name: credit.displayName ?? unnamed(openLibraryAuthorKey(credit.key)),
      href: credit.provider === 'open-library' ? authorHref({ kind: 'external', key: credit.key }) : null,
    })),
  ];
}

/** Native author names for a citation, in the order the agent-credits read returns them. */
export function citationAuthors(agentCredits: Loaded<AgentCreditPage>): string[] {
  return agentCredits.ok ? agentCredits.data.items.filter(credit => credit.role === 'author')
    .map(credit => credit.displayName) : [];
}

const authorLink = 'rounded-sm outline-none decoration-1 underline-offset-4 hover:underline focus-visible:ring-2 '
  + 'focus-visible:ring-ring';

/**
 * Who made the Work, as Goodreads sets it under the title: authors in the
 * Work-title face, then "Translated by" and "Edited by" in smaller type.
 * Native authors link to their profile; authors an import brought from Open
 * Library are named as Open Library lists them and link to their REZICS page. A Work with
 * no credit shows none: the account that created or imported it is not a byline.
 * When one of the two reads fails, the other still shows and the gap is said.
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
  const external = credits.ok ? credits.data.items.filter(credit => credit.participantKind === 'external-reference')
    .sort((a, b) => a.ordinal - b.ordinal) : [];
  if (!native.length && !external.length) return retry;
  const more = (agentCredits.ok && agentCredits.data.nextCursor) || (credits.ok && credits.data.nextCursor);
  const authors = native.filter(credit => credit.role === 'author');
  const separator = authorSeparator([...authors.map(credit => credit.displayName),
    ...external.map(credit => credit.displayName ?? credit.key)]);
  const people = [
    ...authors.map(credit => ({ id: credit.id, name: <Link
      href={authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })}
      title={credit.handle ? `@${credit.handle}` : undefined} className={authorLink}>
      <LocalizedText text={contentText(credit.displayName)} /></Link> })),
    ...external.map(credit => {
      const key = openLibraryAuthorKey(credit.key);
      return { id: credit.id, name: <Link href={authorHref({ kind: 'external', key: credit.key })}
        title={credit.displayName ? t.openLibraryListed : undefined}
        className={cn(authorLink, !credit.displayName && 'font-sans font-medium text-primary text-sm')}>
        {credit.displayName ? <LocalizedText text={contentText(credit.displayName)} /> : t.openLibraryAuthor({ key })}
      </Link> };
    }),
  ];
  const others = (['translator', 'editor'] as const).map(role => ({ role,
    people: native.filter(credit => credit.role === role) })).filter(group => group.people.length);
  // The comma stays on the name before it. A following space is a margin: a space character at the end of a line is discarded, which glued the next name to the comma.
  return <div className="grid gap-1.5">
    {people.length ? <p className="flex flex-wrap items-baseline justify-start gap-y-1
      font-work-title text-foreground/85 text-lg sm:text-2xl">
      <span className="sr-only">{people.length > 1 ? t.authors : t.author}: </span>
      {people.map((person, index) => <span key={person.id} className={cn('min-w-0 max-w-full [overflow-wrap:anywhere]',
        index < people.length - 1 && separator.endsWith(' ') && 'me-[0.35em]')}>
        {person.name}{index < people.length - 1 ? separator.trimEnd() : null}</span>)}
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
