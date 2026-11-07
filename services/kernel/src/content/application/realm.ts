import type {
  RealmCommunityBoard,
  RealmCommunityThread,
  RealmCommunitySelection,
  RealmCommunityPorts,
  RealmDisclosureContext,
  RealmDisclosurePorts,
  RealmSearchPorts,
} from '../contract/index.ts';
import { createRealmCommunity } from './realm-community.ts';
import { createRealmSubjectDisclosure } from './realm-subject-disclosure.ts';
import { createRealmSubjectSearch } from './realm-subject-search.ts';

export function createContentRealmApplication<
  D,
  C extends RealmDisclosureContext,
  A,
  P,
  R,
  W,
  S,
  BD,
  BC,
  B extends RealmCommunityBoard,
  T extends RealmCommunityThread,
  M,
  Selection extends RealmCommunitySelection,
>(ports: {
  disclosure: RealmDisclosurePorts<D, C, A>;
  search: RealmSearchPorts<P, R, W, D, C, S>;
  community: RealmCommunityPorts<BD, BC, B, T, M, Selection>;
}) {
  const disclosure = createRealmSubjectDisclosure(ports.disclosure);
  return Object.freeze({
    disclosure,
    search: createRealmSubjectSearch(ports.search, disclosure),
    community: createRealmCommunity(ports.community),
  });
}
