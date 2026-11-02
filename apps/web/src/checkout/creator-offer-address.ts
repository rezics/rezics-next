import { UUID } from './price';

export type CreatorOfferAddressIssue = { requested: string };
export type CreatorOffersSearch = { cursor?: string; addressIssue?: CreatorOfferAddressIssue };
export type CreatorEditionSearch = { contentEditionId?: string; addressIssue?: CreatorOfferAddressIssue };

function issue(search: Record<string, unknown>, names: string[]): CreatorOfferAddressIssue {
  return {
    requested: names
      .filter((name) => Object.hasOwn(search, name))
      .map((name) => `${name} = ${JSON.stringify(search[name])}`)
      .join('\n'),
  };
}

/** Preserve opaque cursors exactly; only the native reader can validate their signed position. */
export function creatorOffersSearch(search: Record<string, unknown>): CreatorOffersSearch {
  if (search.cursor === undefined || search.cursor === '') return {};
  if (typeof search.cursor !== 'string' || search.cursor.length > 4096)
    return { addressIssue: issue(search, ['cursor']) };
  return { cursor: search.cursor };
}

/** Equal aliases remain compatible. Repetition, even of an equal value, requires a deliberate correction. */
export function creatorEditionSearch(search: Record<string, unknown>): CreatorEditionSearch {
  let selected: string | undefined;
  for (const id of [search.editionId, search.contentEditionId]) {
    if (id === undefined || id === '') continue;
    if (typeof id !== 'string' || !UUID.test(id) || (selected !== undefined && selected !== id))
      return { addressIssue: issue(search, ['editionId', 'contentEditionId']) };
    selected = id;
  }
  return selected === undefined ? {} : { contentEditionId: selected };
}
