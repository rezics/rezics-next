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
import type { PublicDomainSource } from './publication-source.tsx';
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

/** The display fields shared by native credits, public credits and the proposed sourced publication contract. */
export interface BylineCredit {
  id: string; role: string; displayName: string | null; agent?: string | null; handle?: string | null;
  provider?: string | null; key?: string | null; ordinal?: number | null;
}
export interface BylinePage { items: readonly BylineCredit[]; nextCursor: string | null }

/** Credits retain their roles. Importing, directing and drawing never become author bylines. */
export function WorkCredits({ agentCredits, credits, source = null, locale, messages }: {
  agentCredits: Loaded<BylinePage>; credits: Loaded<BylinePage>; source?: PublicDomainSource | null;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const failure = !agentCredits.ok || !credits.ok;
  const retry = failure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
    <TriangleAlertIcon aria-hidden="true" className="size-4 text-destructive-foreground" />
    <span className="text-destructive-foreground">
      {!agentCredits.ok && !credits.ok ? t.creditsUnavailable : t.someCreditsUnavailable}</span>
    <RetryButton label={t.retry} pendingLabel={t.retrying} />
  </div> : null;
  const native = agentCredits.ok ? { entries: agentCredits.data.items, nextCursor: agentCredits.data.nextCursor } : null;
  const external = credits.ok ? { entries: credits.data.items, nextCursor: credits.data.nextCursor } : null;
  const all = new Map<string, BylineCredit>();
  for (const credit of native?.entries ?? []) all.set(credit.id, credit);
  for (const credit of external?.entries ?? []) if (!all.has(credit.id)) all.set(credit.id, credit);
  const ordered = [...all.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const nameOf = (credit: BylineCredit) => credit.displayName
    ?? (credit.provider === 'open-library' && credit.key ? t.openLibraryAuthor({ key: openLibraryAuthorKey(credit.key) })
      : credit.role === 'author' ? t.unknownAuthor : null);
  const name = (credit: BylineCredit) => {
    const label = nameOf(credit);
    if (!label) return null;
    const href = credit.agent ? authorHref({ kind: 'agent', agent: credit.agent, handle: credit.handle ?? null })
      : credit.provider === 'open-library' && credit.key ? authorHref({ kind: 'external', key: credit.key }) : credit.role === 'author' ? source?.url : undefined;
    const text = <LocalizedText text={contentText(label)} />;
    return href ? <Link href={href} className={authorLink} title={credit.handle ? `@${credit.handle}` : undefined}>
      {text}</Link> : text;
  };
  const authors = ordered.filter(credit => credit.role === 'author' && nameOf(credit));
  const separator = authorSeparator(authors.map(credit => nameOf(credit)!));
  const roleLabels: Record<string, string> = {
    translator: t.translatedBy, editor: t.editedBy, director: t.directedBy,
    artist: t.artworkBy, 'animation-studio': t.animationStudio, transcriber: t.transcribedBy,
  };
  const others = Object.entries(roleLabels).map(([role, label]) => ({ role, label,
    people: ordered.filter(credit => credit.role === role && nameOf(credit)) })).filter(group => group.people.length);
  const more = native?.nextCursor || external?.nextCursor;
  return <div className="grid gap-1.5">
    {authors.length ? <p className="flex flex-wrap items-baseline justify-start gap-y-1
      font-work-title text-foreground/85 text-lg sm:text-2xl">
      <span className="sr-only">{authors.length > 1 ? t.authors : t.author}: </span>
      {authors.map((credit, index) => <span key={credit.id} className={cn('min-w-0 max-w-full [overflow-wrap:anywhere]',
        index < authors.length - 1 && separator.endsWith(' ') && 'me-[0.35em]')}>
        {name(credit)}{index < authors.length - 1 ? separator.trimEnd() : null}</span>)}
    </p> : null}
    {others.length ? <div className="flex flex-wrap justify-start gap-x-4 gap-y-1 text-muted-foreground text-sm">
      {others.map(group => <p key={group.role}>{group.label}{' '}
        {group.people.map((credit, index) => <span key={credit.id}>{index ? ', ' : ''}{name(credit)}</span>)}
      </p>)}
    </div> : null}
    {more ? <p className="text-muted-foreground text-xs">{t.moreCredits}</p> : null}
    {retry}
  </div>;
}

export function WorkCreditsSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-2">
    <Skeleton className="h-5 w-16 rounded-md" /><Skeleton className="h-5 w-40 rounded-md" />
  </div>;
}
