import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { pageContext, type SubjectPageData } from '../../../features/pages/subject';
import { pageProfile } from '../page-read';
import { useOperation } from '../../../kernel/exposure';
import { m } from '../../../paraglide/messages.js';
import { isRecord, linkClass } from '../../../features/pages/shared';
import { CollectionVisit, collectionWindowHref, type Coordinate, type Movement } from './visit';

type Navigation = {
  visit: CollectionVisit;
  search: string;
  hash: string;
  cursor: Coordinate;
  move: (event: MouseEvent<HTMLAnchorElement>, movement: Movement, cursor: Coordinate) => void;
};
export const CollectionWindowsContext = createContext<Navigation | null>(null);

/** Owned by the named route, above the replacing cursor-keyed page. */
export function useCollectionWindows(input: {
  page?: SubjectPageData;
  owner: string;
  revision: number;
  failure?: string | undefined;
  view: string;
  locale: string;
  cursor: Coordinate;
  search: string;
  hash: string;
  navigate: (href: string) => void;
  retry: () => void;
}) {
  const exposed = useOperation('account.collections');
  const profile = input.page ? pageProfile(input.page) : undefined;
  const publication = profile ? JSON.stringify(profile) : null;
  const slot = useRef<{ scope: string | null; owner: string; visit: CollectionVisit }>({ scope: null, owner: JSON.stringify([input.owner, input.view, input.locale]), visit: new CollectionVisit() });
  const owner = JSON.stringify([input.owner, input.view, input.locale]);
  let admitted = false;
  let denied = false;
  if (input.page) {
    const plan = planReads(platformRegistry, input.page.document as CompositionDocument, pageContext(input.page));
    const entry = Object.entries(plan.reads).find(([, read]) => read.kind === 'accountCollections');
    const response = entry ? input.page.reads[entry[0]] : undefined;
    admitted = response?.status === 200 && isRecord(response.body) && Array.isArray(response.body.collections);
    denied = response?.status === 401 || response?.status === 403;
  }
  const scope = slot.current.owner === owner && !input.page && input.failure !== 'denied' && input.view === 'collections' && exposed
    ? slot.current.scope : profile && input.view === 'collections' && exposed && profile.publicViews.collections && !denied
    ? JSON.stringify([profile.id, input.view, input.locale, publication]) : null;
  const [, render] = useState(0);
  if (slot.current.scope !== scope || slot.current.owner !== owner) {
    slot.current.visit.retire();
    slot.current = { scope, owner, visit: new CollectionVisit() };
  }
  const { visit } = slot.current;
  useLayoutEffect(() => {
    visit.receive(input.cursor, admitted);
    render((revision) => revision + 1);
  }, [visit, input.page, input.cursor, admitted, input.revision]);
  useEffect(() => () => visit.retire(), [visit]);
  if (!scope) return null;
  return {
    visit, search: input.search, hash: input.hash, cursor: input.cursor,
    move(event: MouseEvent<HTMLAnchorElement>, movement: Movement, cursor: Coordinate) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!visit.begin(movement, cursor, event.currentTarget)) return;
      render((revision) => revision + 1);
      const href = collectionWindowHref(input.search, input.hash, cursor);
      if (cursor === input.cursor) input.retry();
      else input.navigate(href);
    },
  };
}

export function CollectionWindowControls({ next, locale, failed = false, invalid = false }: {
  next?: string | null; locale: string; failed?: boolean; invalid?: boolean;
}) {
  const navigation = useContext(CollectionWindowsContext);
  if (!navigation || !navigation.visit.live) return null;
  const { visit, search, hash, move } = navigation;
  const options = { locale: locale as never };
  const action = (label: string, movement: Movement, cursor: Coordinate, slot: string) => (
    <a data-slot={slot} href={collectionWindowHref(search, hash, cursor)}
      aria-disabled={visit.pending || undefined}
      onClick={(event) => move(event, movement, cursor)}
      className={`${linkClass} inline-flex min-h-11 min-w-11 items-center text-sm font-medium`}>{label}</a>
  );
  return <nav aria-label={m.subject_collections({}, options)} className="flex flex-wrap gap-x-4 gap-y-2">
    {failed ? (
      invalid ? action(m.public_account_start_again({}, options), 'first', null, 'restart') :
      action(m.public_account_retry({}, options), visit.target?.movement ?? 'next', visit.target ? visit.target.cursor : navigation.cursor, 'retry')
    ) : <>
      {visit.previous !== undefined && action(m.prq_previous({}, options), 'previous', visit.previous, 'previous')}
      {visit.current !== null && action(m.library_collections_first_page({}, options), 'first', null, 'first')}
      {next && next.length <= 4096 && action(m.threads_next_page({}, options), 'next', next, 'continuation')}
    </>}
  </nav>;
}
