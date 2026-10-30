import board from '../../src/kernel/recorded/board.json';
import realm from '../../src/kernel/recorded/realm.json';
import space from '../../src/kernel/recorded/space-address.json';
import agent from '../../src/kernel/recorded/agent-page.json';
import collection from '../../src/kernel/recorded/library-collection.json';
import recordedSubject from '../../src/kernel/recorded/subject.json';
import thread from '../../src/kernel/recorded/thread.json';
import { continuationSubject } from '../../src/kernel/fake/view-continuation.ts';
import { subjectHref, subjectViewHref } from '../../src/subject/subject-href.ts';
import { threadSlug } from '../../src/threads/thread-href.ts';

const threadPath = `/en/threads/${thread.thread.id}/${threadSlug(thread.thread.title)}`;
const subjectPath = subjectHref(
  { id: recordedSubject.subject.id, label: recordedSubject.subject.labels.en },
  'en',
).href;
const subjectViewPath = subjectViewHref(continuationSubject, 'en', 'details');
const agentPath = `/en/@${agent.handle}`;

export const publicCacheSamples: Record<string, string> = {
  '/': '/en',
  '/search': '/en/search?q=The',
  '/realms/$id': `/en/realms/${realm.realm.realmId}`,
  '/spaces/$address': `/en/spaces/${space.address}`,
  '/boards/$id': `/en/boards/${board.board.id}`,
  '/threads/$id_/$slug': threadPath,
  '/subjects/$id_/$slug': subjectPath,
  '/subjects/$id_/$slug_/$view': subjectViewPath,
  '/subjects/$id_/$slug_/relations': subjectViewHref(continuationSubject, 'en', 'relations'),
  '/@{$handle}': agentPath,
  '/@{$handle}_/$view': '/en/@helper/reviews',
  '/collections/$id': `/en/collections/${collection.collection.id}`,
};

export const publicCacheGrowthSample = `${threadPath}?cache-test=recorded`;
