import board from '../../src/kernel/recorded/board.json';
import realm from '../../src/kernel/recorded/realm.json';
import space from '../../src/kernel/recorded/space-address.json';
import thread from '../../src/kernel/recorded/thread.json';
import { threadSlug } from '../../src/threads/thread-href.ts';

const threadPath = `/en/threads/${thread.thread.id}/${threadSlug(thread.thread.title)}`;

export const publicCacheSamples: Record<string, string> = {
  '/': '/en',
  '/search': '/en/search?q=The',
  '/realms/$id': `/en/realms/${realm.realm.realmId}`,
  '/spaces/$address': `/en/spaces/${space.address}`,
  '/boards/$id': `/en/boards/${board.board.id}`,
  '/threads/$id_/$slug': threadPath,
};

export const publicCacheGrowthSample = `${threadPath}?cache-test=recorded`;
