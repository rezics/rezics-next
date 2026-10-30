import type { ReactNode } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

export type PublicationLinkTarget = { id: string; membershipKind: 'dynamic'; builtinKind?: never };

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
  if (!target.id || target.membershipKind !== 'dynamic' || target.builtinKind !== undefined) return null;
  return (
    <a className={className} href={`/${getLocale()}/collections/${encodeURIComponent(target.id)}/publish`}>
      {children ?? m.library_publication_heading()}
    </a>
  );
}
