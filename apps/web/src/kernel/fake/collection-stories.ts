import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import memberPage from '../recorded/library-collection-members.json';
import subject from '../recorded/subject.json';
import agentPage from '../recorded/agent-page.json';
import fixtures from '../fixtures.json';
import type { CollectionMember } from '../../library/reads';

const recordedCollectionId = '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2';
const viewerId = 'story-viewer';

// Match the actual book, not IDs shared by independently recorded scenarios. No matching Genji art is served.
const memberCovers = new Map([
  ['01a17a3b-0884-721b-91ef-d7ffd7bb58e4', subject.summary.cover],
  ['01a17a3b-6b89-748f-a486-33c354ef3c9a', agentPage.reads.r2.body.links[0]!.summary.cover],
]);
const princeAuthor = subject.subject.statements['schema:author'][0]!.value.content;
const soseki = fixtures.subjects.find((item) => item.id === '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02')!;

// Illustrative FULL DTO values, not newly captured native facts. Prince uses subject.json's author/year and
// related labels; Kokoro uses fixtures.json's author record and work description (1914, not an edition date).
// Snow Country adds the author and first book publication (1937; the expanded text followed in 1948).
// Genji adds its author only: circa 1008 cannot be truthfully represented by the existing exact-year Fact.
const memberFacts: Record<string, NonNullable<CollectionMember['facts']>> = {
  '01a17a3b-6c01-77c8-94fd-810a3ae73369': {
    'schema:author': [
      { kind: 'item', id: 'illustrative:yasunari-kawabata', labels: { en: 'Yasunari Kawabata', ja: '川端康成' } },
    ],
    'schema:datePublished': [{ kind: 'time', year: 1937 }],
  },
  '01a17a3b-6bc3-764f-8727-7872d197bd93': {
    'schema:author': [
      { kind: 'item', id: 'illustrative:murasaki-shikibu', labels: { en: 'Murasaki Shikibu', ja: '紫式部' } },
    ],
  },
  '01a17a3b-0884-721b-91ef-d7ffd7bb58e4': {
    'schema:author': [
      { kind: 'item', id: princeAuthor, labels: subject.related['01a17a3b-07ab-779f-a76f-c4de973680d4'].labels },
    ],
    'schema:datePublished': [
      {
        kind: 'time',
        year: Number(subject.subject.statements['schema:datePublished'][0]!.value.content.time.slice(1, 5)),
      },
    ],
  },
  '01a17a3b-6b89-748f-a486-33c354ef3c9a': {
    'schema:author': [{ kind: 'item', id: soseki.id, labels: { en: soseki.labels.en!, ja: soseki.labels.ja! } }],
    'schema:datePublished': [{ kind: 'time', year: 1914 }],
  },
};
export const collectionStoryMembers = memberPage.members.map((member) => ({
  ...member,
  subject: { ...member.subject, cover: memberCovers.get(member.subject.id) ?? member.subject.cover },
  facts: memberFacts[member.subject.id]!,
}));

export const collectionStoryPaths = {
  curatorPublicMany: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba3',
  readerPublicMany: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba4',
  curatorPrivateEmpty: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba5',
  readerPrivate: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba6',
  curatorPublicOnePage: '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba7',
} as const;

type Variant = {
  title: string;
  visibility: 'public' | 'private';
  owner: boolean;
  memberCount: number;
  memberLimit: number;
  next: string | null;
};

const variants = new Map<string, Variant>([
  [
    collectionStoryPaths.curatorPublicMany,
    {
      title: 'A curator’s reading shelf',
      visibility: 'public',
      owner: true,
      memberCount: 4,
      memberLimit: 4,
      next: 'next-page',
    },
  ],
  [
    collectionStoryPaths.readerPublicMany,
    {
      title: 'A reader’s reading shelf',
      visibility: 'public',
      owner: false,
      memberCount: 4,
      memberLimit: 4,
      next: 'next-page',
    },
  ],
  [
    collectionStoryPaths.curatorPrivateEmpty,
    { title: 'A private empty shelf', visibility: 'private', owner: true, memberCount: 0, memberLimit: 0, next: null },
  ],
  [
    collectionStoryPaths.readerPrivate,
    { title: 'A private shelf', visibility: 'private', owner: false, memberCount: 4, memberLimit: 4, next: null },
  ],
  [
    collectionStoryPaths.curatorPublicOnePage,
    { title: 'A one-page shelf', visibility: 'public', owner: true, memberCount: 1, memberLimit: 1, next: null },
  ],
]);

function copyRecording(recording: KernelRecording | undefined): KernelRecording | undefined {
  return recording ? structuredClone(recording) : undefined;
}

function illustratedMembers(recording: KernelRecording | undefined): KernelRecording | undefined {
  const copy = copyRecording(recording);
  const members = copy?.members;
  if (!Array.isArray(members)) return copy;
  for (const item of members) {
    if (!item || typeof item !== 'object' || !('subject' in item)) continue;
    const subject = item.subject;
    if (!subject || typeof subject !== 'object' || !('id' in subject) || !('label' in subject)) continue;
    const illustration = collectionStoryMembers.find((member) => member.subject.id === subject.id);
    // A UUID alone is not enough to associate independently recorded book metadata or art.
    if (
      !illustration ||
      !('type' in subject) ||
      subject.type !== illustration.subject.type ||
      JSON.stringify(subject.label) !== JSON.stringify(illustration.subject.label)
    )
      continue;
    if ('cover' in subject && subject.cover === null) subject.cover = structuredClone(illustration.subject.cover);
    if (!('facts' in item)) Object.assign(item, { facts: structuredClone(illustration.facts) });
  }
  return copy;
}

function variantRecording(
  id: string,
  membersPage: boolean,
  request: Request,
  recordings: Record<string, KernelRecording>,
) {
  const variant = variants.get(id);
  if (!variant) return undefined;
  if (!variant.owner && variant.visibility === 'private' && !request.headers.has('authorization')) {
    return { status: 404, type: 'https://rezics.com/problems/not_found', title: 'Not Found', code: 'not_found' };
  }
  const base = recordings['library-collection']?.collection;
  if (!base || typeof base !== 'object') return undefined;
  if (!membersPage) {
    return {
      status: 200,
      collection: {
        ...structuredClone(base),
        id,
        curatorAccountId: variant.owner ? viewerId : 'story-curator',
        title: variant.title,
        visibility: variant.visibility,
        memberCount: variant.memberCount,
      },
    };
  }
  const source = illustratedMembers(recordings['library-collection-members']);
  const sourceMembers = Array.isArray(source?.members) ? source.members : [];
  return {
    ...source,
    status: 200,
    members: sourceMembers.slice(0, variant.memberLimit),
    next: variant.next,
  };
}

function story({
  request,
  recordings,
  match,
}: {
  request: Request;
  recordings: Record<string, KernelRecording>;
  match: RegExpExecArray | null;
}) {
  const id = match?.[1];
  if (!id) return undefined;
  const isMembers = match?.[2] === '/members';
  if (id === recordedCollectionId && isMembers) return illustratedMembers(recordings['library-collection-members']);
  return variantRecording(id, isMembers, request, recordings);
}

export const routes: FakeRoute[] = [{ method: 'GET', path: /^\/v1\/collections\/([^/]+)(\/members)?$/, story }];
