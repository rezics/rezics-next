import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

/** Ordinary saved identities omit builtinKind; built-ins keep their kind and never offer a rule editor. */
export function isOrdinarySavedQuery(collection: { builtinKind?: string | null | undefined }): boolean {
  return !collection.builtinKind;
}

/** Navigation hint for the current owner. The private GET still authorizes the definition. */
export function RuleEditLink({
  collection,
  viewerId,
  allowed,
  className = 'inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2',
}: {
  collection: { id: string; curatorAccountId?: string | null; membershipKind?: string; builtinKind?: string };
  viewerId: string | null;
  allowed: boolean;
  className?: string;
}) {
  if (
    !allowed ||
    !viewerId ||
    collection.curatorAccountId !== viewerId ||
    collection.membershipKind !== 'dynamic' ||
    !isOrdinarySavedQuery(collection)
  )
    return null;
  return (
    <a href={`/${getLocale()}/collections/${encodeURIComponent(collection.id)}/rule`} className={className}>
      {m.library_rule_edit()}
    </a>
  );
}
