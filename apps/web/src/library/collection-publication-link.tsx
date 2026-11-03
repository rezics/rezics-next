import type { ReactNode } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

export type PublicationLinkTarget = { id: string; membershipKind: 'dynamic'; builtinKind?: never };

export function isPublicationLinkTarget(target: {
  id?: string;
  membershipKind?: string;
  builtinKind?: string;
}): target is PublicationLinkTarget {
  return Boolean(target.id) && target.membershipKind === 'dynamic' && target.builtinKind === undefined;
}

export function publicationHref(id: string): string {
  return `/${getLocale()}/collections/${encodeURIComponent(id)}/publish`;
}

/** Owner menus supply their stored saved-dynamic identity. This link conveys no publication authority. */
export function PublicationLink({
  target,
  children,
  className,
}: {
  target: PublicationLinkTarget;
  children?: ReactNode;
  className?: string;
}) {
  if (!isPublicationLinkTarget(target)) return null;
  return (
    <a className={className} href={publicationHref(target.id)}>
      {children ?? m.library_publication_heading()}
    </a>
  );
}
