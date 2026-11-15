import type { ReactNode } from 'react';
import { isOrdinarySavedQuery } from '../saved-query-results';
import { PublicationLink } from '../collection-publication-link';
import { buttonVariants } from '@rezics/ui/shadcn/button';

export const savedQueryPublicationActionClassName = buttonVariants({ variant: 'outline', className: 'h-auto min-h-7 max-w-full whitespace-normal break-words' });

export type SavedQueryPublicationCollection = {
  id: string;
  curatorAccountId?: string | null;
  membershipKind?: string;
  builtinKind?: string;
};

/** Owner-only handoff. Built-ins, curated identities and other viewers get no publication entry. */
export function admitsSavedQueryPublication(
  collection: SavedQueryPublicationCollection,
  viewerId: string | null,
  allowed: boolean,
): boolean {
  return (
    allowed &&
    Boolean(viewerId) &&
    collection.curatorAccountId === viewerId &&
    collection.membershipKind === 'dynamic' &&
    isOrdinarySavedQuery(collection) &&
    Boolean(collection.id) &&
    collection.builtinKind === undefined
  );
}

/** Management consumer slot: a link, never a second publication command. */
export function SavedQueryPublicationAction({
  collection,
  viewerId,
  allowed,
  className = savedQueryPublicationActionClassName,
  children,
}: {
  collection: SavedQueryPublicationCollection;
  viewerId: string | null;
  allowed: boolean;
  className?: string;
  children?: ReactNode;
}) {
  if (!admitsSavedQueryPublication(collection, viewerId, allowed)) return null;
  return (
    <span data-slot="saved-query-publication">
      <PublicationLink target={{ id: collection.id, membershipKind: 'dynamic' }} className={className}>
        {children}
      </PublicationLink>
    </span>
  );
}
