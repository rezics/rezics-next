import type { KernelClient } from '@rezics/client';
import type { MineCollection } from '../../src/library/mine-collections';
import type { MineCollectionsViewerPage } from '../../src/library/mine-collections-route';
import type { LibraryPin } from '../../src/library/pins-read';
import { collectionPresentationOf } from '../../src/library/collection-presentation';
import { librarySubject, subjectSummary } from './subjects';

type Page = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['collections']['get']>>['data']>,
  { collections: unknown[] }
>;
type Collection = Extract<Page['collections'][number], { membershipKind: 'curated' }>;
type ReadyCollection = Collection & Required<Pick<Collection, 'previewMembers' | 'previewStatus'>>;
type PreviewMember = ReadyCollection['previewMembers'][number];

export function previewMember(subject = subjectSummary()): PreviewMember {
  return { subjectId: subject.id, subject: structuredClone(subject) };
}

export function nativeCollection({
  id = '019a0000-0000-7000-8000-000000000004',
  title = 'Reading collection',
  curatorAccountId = '019a0000-0000-7000-8000-000000000001',
  previewMembers = [previewMember()],
}: {
  id?: Collection['id'];
  title?: Collection['title'];
  curatorAccountId?: Collection['curatorAccountId'];
  previewMembers?: PreviewMember[];
} = {}): ReadyCollection {
  return {
    id,
    membershipKind: 'curated',
    curatorAccountId,
    title,
    description: null,
    visibility: 'private',
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    coverMediaId: null,
    revision: 1,
    memberCount: previewMembers.length,
    orderEpoch: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    curator: null,
    previewMembers: structuredClone(previewMembers),
    previewStatus: 'ready',
  };
}

export function mineCollection(native = nativeCollection()): MineCollection {
  return {
    ...collectionPresentationOf(native),
    id: native.id,
    curatorAccountId: native.curatorAccountId,
    title: native.title,
    curator: native.curator ? { ...native.curator } : null,
    membershipKind: native.membershipKind,
    visibility: native.visibility,
    memberCount: native.memberCount,
    updatedAt: native.updatedAt,
    preview: { state: 'loaded', members: native.previewMembers.map(({ subject }) => librarySubject(subject)) },
  };
}

export function savedQueryCollection(
  id: string,
  {
    curatorAccountId = 'alice',
    membershipKind = 'dynamic',
    builtinKind,
  }: {
    curatorAccountId?: MineCollection['curatorAccountId'];
    membershipKind?: MineCollection['membershipKind'];
    builtinKind?: MineCollection['builtinKind'];
  } = {},
): MineCollection {
  return {
    id,
    curatorAccountId,
    title: id,
    membershipKind,
    ...(builtinKind === undefined ? {} : { builtinKind }),
    curator: null,
    memberCount: 931,
    updatedAt: '2025-01-02T03:04:05Z',
    visibility: 'private',
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
  };
}

export function libraryPin(id: string, title: string): LibraryPin {
  return { collectionId: id, target: { id, title, membershipKind: 'curated' } };
}

export function mineCollectionsViewerPage(
  subject: string,
  cursor: string | null = null,
  layout: 'rows' | 'previews' = 'previews',
): MineCollectionsViewerPage {
  return {
    sessionSubject: subject,
    requested: { cursor, layout },
    page: {
      signedIn: true,
      state: 'loaded',
      next: `next-${subject}`,
      collections: [
        mineCollection(
          nativeCollection({
            id: 'shared-private',
            curatorAccountId: subject,
            title: `Private ${subject}`,
            previewMembers: [
              previewMember(
                subjectSummary({ id: `subject-${subject}`, label: { value: `Preview ${subject}`, language: 'en' } }),
              ),
            ],
          }),
        ),
      ],
      navigationCollections: [
        {
          id: `state-${subject}`,
          title: `Navigation ${subject}`,
          curator: null,
          membershipKind: 'dynamic',
          builtinKind: 'state',
        },
      ],
    },
    pins: {
      state: 'loaded',
      origin: { sessionSubject: subject, credentialAgrees: true, requestedLimit: 100 },
      revision: 7,
      next: null,
      canUpdate: true,
      canRemove: true,
      pins: [libraryPin(`pin-${subject}`, `Pinned ${subject}`)],
    },
  };
}
