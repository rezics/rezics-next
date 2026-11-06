import { subjectHref } from '../../../subject/subject-href';

const localOrigin = 'https://rezics.invalid';
const collectionPage = /^\/(?:en|zh-Hant|zh-Hans|ja|ko|fr|de|es)\/collections\/[0-9a-f-]{36}$/i;
const occurrence = /^[0-9a-f-]{36}$/i;

/**
 * A preview member opens its Subject, returning to this exact Collection occurrence. Library owns the return-address
 * contract and the feed cannot import its internals; this mirrors that contract for Home's plain Collection pages.
 * A differential test pins the output to Library's comparison link.
 */
export function homeCollectionMemberHref(input: {
  id: string;
  label: string;
  locale: string;
  collectionHref: string;
  memberId: string;
}): string {
  const target = subjectHref({ id: input.id, label: input.label }, input.locale).href;
  if (!collectionPage.test(input.collectionHref) || !occurrence.test(input.memberId)) return target;
  const url = new URL(target, localOrigin);
  url.searchParams.set('via', `${input.collectionHref}#collection-member-${input.memberId}`);
  return `${url.pathname}${url.search}${url.hash}`;
}
