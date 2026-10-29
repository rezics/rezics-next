import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

const recordedCollectionId = '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2';
const distinctKokoroCover = '0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0003';
const viewerId = 'story-viewer';

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

function distinctCovers(recording: KernelRecording | undefined): KernelRecording | undefined {
  const copy = copyRecording(recording);
  const members = copy?.members;
  if (!Array.isArray(members)) return copy;
  for (const item of members) {
    if (!item || typeof item !== 'object' || !('subject' in item)) continue;
    const subject = item.subject;
    if (!subject || typeof subject !== 'object' || !('label' in subject) || !('cover' in subject)) continue;
    if (subject.label !== 'Kokoro' || !subject.cover || typeof subject.cover !== 'object') continue;
    subject.cover = { ...subject.cover, media: distinctKokoroCover };
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
  const source = distinctCovers(recordings['library-collection-members']);
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
  if (id === recordedCollectionId && isMembers) return distinctCovers(recordings['library-collection-members']);
  return variantRecording(id, isMembers, request, recordings);
}

export const routes: FakeRoute[] = [{ method: 'GET', path: /^\/v1\/collections\/([^/]+)(\/members)?$/, story }];
