import { contextHref } from '../../pages/context-navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { subjectHref } from '../../../subject/subject-href';
import { validMusicReleaseAddress, type MusicReleaseAddress } from './model';

export type MusicReleaseFocus = { holder: string; statementId: string };
export type MusicReleaseRoute = { address: MusicReleaseAddress; focus?: MusicReleaseFocus };
export type MusicReleaseReturn = {
  address: MusicReleaseAddress;
  locale: string;
  realm?: string;
  label: string;
  revision: number;
  digest: string;
  focus?: MusicReleaseFocus;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function focusFrom(search: URLSearchParams): MusicReleaseFocus | undefined {
  const holder = search.get('musicReturnHolder');
  const statementId = search.get('musicReturnStatement');
  return holder && statementId && uuid.test(holder) && uuid.test(statementId) ? { holder, statementId } : undefined;
}

/** Parse only bounded window addresses supplied by this reader's exact Subject route. */
export function musicReleaseRoute(search: string, base: MusicReleaseAddress): MusicReleaseRoute {
  const parameters = new URLSearchParams(search);
  const returnKeys = [...parameters.keys()].filter((key) => key.startsWith('musicReturn'));
  if (!returnKeys.length) return { address: base };
  const allowed = new Set([
    'musicReturnStream',
    'musicReturnCursor',
    'musicReturnRevision',
    'musicReturnDigest',
    'musicReturnHolder',
    'musicReturnStatement',
  ]);
  if (new Set(returnKeys).size !== returnKeys.length || returnKeys.some((key) => !allowed.has(key)))
    return { address: base };
  const revisionText = parameters.get('musicReturnRevision');
  const digest = parameters.get('musicReturnDigest');
  const revision = revisionText && /^\d{1,16}$/u.test(revisionText) ? Number(revisionText) : undefined;
  if (revision === undefined || !digest || digest.length > 128) return { address: base };
  const address: MusicReleaseAddress = {
    id: base.id,
    context: base.context,
    ...(parameters.get('musicReturnStream') ? { stream: parameters.get('musicReturnStream')! } : {}),
    ...(parameters.get('musicReturnCursor') ? { cursor: parameters.get('musicReturnCursor')! } : {}),
    expectedRevision: revision,
    expectedDigest: digest,
  };
  if (!validMusicReleaseAddress(address)) return { address: base };
  const focus = focusFrom(parameters);
  return focus ? { address, focus } : { address };
}

function addressedSubject(href: string, context: string, realm?: string) {
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set('context', context);
  return contextHref(`${url.pathname}${url.search}`, realm);
}

/** Keep one current address and row key in the existing Subject return path; no page payload is retained. */
export function musicReleaseReturnHref({
  address,
  locale,
  realm,
  label,
  revision,
  digest,
  focus,
}: MusicReleaseReturn): string {
  const url = new URL(
    addressedSubject(subjectHref({ id: address.id, label }, locale).href, address.context, realm),
    'https://rezics.invalid',
  );
  if (address.stream) url.searchParams.set('musicReturnStream', address.stream);
  if (address.cursor) url.searchParams.set('musicReturnCursor', address.cursor);
  url.searchParams.set('musicReturnRevision', String(revision));
  url.searchParams.set('musicReturnDigest', digest);
  if (focus) {
    url.searchParams.set('musicReturnHolder', focus.holder);
    url.searchParams.set('musicReturnStatement', focus.statementId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function musicReleaseLinkHref(href: string, current: MusicReleaseReturn): string {
  if (!/^\/[^/]+\/subjects\//u.test(href)) return href;
  const addressed = addressedSubject(href, current.address.context, current.realm);
  return withSubjectVisitReturn(addressed, musicReleaseReturnHref(current), current.locale);
}

/** Target links retain the selected Context and return through the existing Subject visit contract. */
export function musicReleaseTargetHref(
  target: { id: string; label: string },
  current: MusicReleaseReturn,
): string {
  return musicReleaseLinkHref(subjectHref(target, current.locale).href, current);
}
