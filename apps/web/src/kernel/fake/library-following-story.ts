import type { FakeRoute } from '../fake-modules.ts';
import type { FollowEdge } from '../../library/follow-transport';
import spaceRecording from '../recorded/space.json';
import followsRecording from '../recorded/library-follows.json';
import subjectRecording from '../recorded/subject.json';

export type LibraryFollowingStoryMode =
  | 'recorded'
  | 'none'
  | 'inactive-page'
  | 'last-follow'
  | 'many'
  | 'unavailable'
  | 'error'
  | 'hidden'
  | 'unfollow-failure'
  | 'reading-preparing'
  | 'reading-no-destination'
  | 'reading-unavailable'
  | 'reading-denied'
  | 'reading-retired'
  | 'reading-long'
  | 'reading-current-source'
  | 'return-readmission'
  | 'same-cursor-retry'
  | 'native-zone'
  | 'zone-unavailable';

type ListAdmission = 'ready' | 'denied' | 'unavailable';
let mode: LibraryFollowingStoryMode = 'recorded';
let observation = 0;
let admission: ListAdmission = 'ready';
let readmitted = false;
let selectedTitle = followsRecording.follows[0]!.target.label;
const removed = new Set<string>();
const listReads: { cursor: string | null; targetType: string | null }[] = [];

export const followingStoryCursor = 'following/native+page/2';
export const followingStorySpaceId = followsRecording.follows[0]!.targetId;
export const followingStoryCollectionId = followsRecording.follows[1]!.targetId;
export const followingStoryZoneId = '00000000-0000-4000-8000-000000000084';
export const followingStoryZoneTitle = 'A quiet reading zone';

export function setLibraryFollowingStoryMode(next: LibraryFollowingStoryMode): void {
  mode = next;
  observation = 0;
  admission = 'ready';
  readmitted = false;
  selectedTitle = followsRecording.follows[0]!.target.label;
  removed.clear();
  listReads.length = 0;
}

/** Explicit story transitions; they never impersonate a product command or store a prior page. */
export function setLibraryFollowingStoryAdmission(next: ListAdmission): void {
  if (admission !== 'ready' && next === 'ready') readmitted = true;
  admission = next;
}

export function libraryFollowingStoryReads() {
  return [...listReads];
}

function zoneRow(targetId = followingStoryZoneId): FollowEdge {
  return {
    targetId,
    targetType: 'zone',
    state: 'following',
    reason: 'explicit',
    updatedAt: followsRecording.follows[0]!.updatedAt,
    ownerId: '00000000-0000-4000-8000-000000000001',
    target: { id: targetId, type: 'zone', label: followingStoryZoneTitle },
    destination: { kind: 'zone', zoneId: targetId },
  };
}

/** Use the installed FULL wire shapes: Subjects have language-tagged labels, other targets plain labels. */
function nativeRows(): FollowEdge[] {
  const rows: FollowEdge[] = followsRecording.follows.map((source) => ({
    targetId: source.targetId,
    targetType: source.targetType as FollowEdge['targetType'],
    state: source.state as FollowEdge['state'],
    reason: source.reason as FollowEdge['reason'],
    updatedAt: source.updatedAt,
    ownerId: '00000000-0000-4000-8000-000000000001',
    target:
      source.targetType === 'subject'
        ? {
            id: source.target.id,
            type: source.target.type,
            types: ['schema:Book'],
            label: { value: source.target.label, language: 'en' },
            creativeWork: true,
            cover: null,
          }
        : { id: source.target.id, type: source.target.type, label: source.target.label },
  }));
  if (mode === 'native-zone') rows.unshift(zoneRow());
  if (mode === 'zone-unavailable') {
    const hidden = zoneRow('00000000-0000-4000-8000-000000000085');
    return [
      { ...zoneRow(), destination: { kind: 'unavailable' } },
      { ...hidden, target: null },
    ];
  }
  return [
    ...rows,
    {
      targetId: subjectRecording.summary.id,
      targetType: 'subject',
      state: 'following',
      reason: 'explicit',
      updatedAt: followsRecording.follows[2]!.updatedAt,
      ownerId: rows[0]!.ownerId,
      target: {
        ...subjectRecording.summary,
        cover: {
          ...subjectRecording.summary.cover,
          variants: subjectRecording.summary.cover.variants.map((variant) => ({ ...variant, format: 'webp' as const })),
        },
      },
    },
  ];
}

function fullFollowingProjection(follow: FollowEdge): FollowEdge {
  if (follow.targetType !== 'space') return follow;
  if (mode === 'reading-no-destination')
    return { ...follow, destination: { kind: 'unavailable' }, actions: { status: 'unavailable' } };
  return {
    ...follow,
    destination: { kind: 'space', spaceId: follow.targetId, address: spaceRecording.space.address },
    actions: {
      status: 'available',
      resourceType: 'community.realm',
      resourceId: spaceRecording.space.realmId,
      viewerActions: [{ action: 'realm:join', operations: ['realm.join', 'realm.leave'] }],
    },
  };
}

function page(follows: FollowEdge[], next: string | null, targetType: string | null) {
  // The synthetic producer selects the population, rather than teaching the browser to filter a mixed page.
  const rows = follows.filter(
    (follow) => !removed.has(follow.targetId) && (!targetType || follow.targetType === targetType),
  );
  return { status: 200, follows: rows.map(fullFollowingProjection), next };
}

function list(request: Request) {
  const query = new URL(request.url).searchParams;
  const targetType = query.get('targetType');
  listReads.push({ cursor: query.get('cursor'), targetType });
  if (mode === 'unavailable' || admission === 'unavailable')
    return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
  if (admission === 'denied') return { status: 403, code: 'forbidden' };
  if (mode === 'error')
    return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
  const base = nativeRows();
  if (mode === 'reading-long' || mode === 'reading-current-source' || (mode === 'return-readmission' && readmitted)) {
    observation++;
    selectedTitle =
      mode === 'reading-long'
        ? '長い夜にゆっくり読む本を探している人たちのための、長い名前を持つ静かな読書コミュニティ '.repeat(3)
        : mode === 'return-readmission'
          ? 'A quiet space, open again'
          : `Current community observation ${observation}`;
    return page(
      base.map((follow) =>
        follow.targetType === 'space'
          ? { ...follow, target: { id: follow.targetId, type: 'space', label: selectedTitle } }
          : follow,
      ),
      null,
      targetType,
    );
  }
  if (mode === 'none') return page([], null, targetType);
  if (mode === 'inactive-page')
    return page(
      base.map((follow) => ({ ...follow, state: 'unfollowed' })),
      'next-page',
      targetType,
    );
  if (mode === 'last-follow')
    return page(
      base.filter((follow) => follow.targetId === followsRecording.follows[2]!.targetId),
      null,
      targetType,
    );
  if (mode === 'hidden')
    return page(
      base.map((follow, index) => (index < 2 ? { ...follow, target: null } : follow)),
      null,
      targetType,
    );
  if (mode === 'many') {
    const follows = Array.from({ length: 20 }, (_, index): FollowEdge => {
      const source = base[index % base.length]!;
      const targetId = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
      const label = `Following item ${index + 1}`;
      return {
        ...source,
        targetId,
        target:
          source.targetType === 'subject'
            ? {
                id: targetId,
                type: 'schema:Book',
                types: ['schema:Book'],
                label: { value: label, language: 'en' },
                creativeWork: true,
                cover: null,
              }
            : { id: targetId, type: source.targetType, label },
      };
    });
    return page(follows, 'next-page', targetType);
  }
  return page(
    base,
    mode === 'same-cursor-retry' || mode === 'native-zone' ? 'following/native+page/3' : null,
    targetType,
  );
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/spaces/${followingStorySpaceId}`,
    story: () => {
      if (mode === 'reading-preparing') return new Promise(() => {});
      if (mode === 'reading-unavailable') return { status: 503, code: 'unavailable' };
      if (mode === 'reading-denied') return { status: 403, code: 'forbidden' };
      if (mode === 'reading-retired') return { status: 410, code: 'gone' };
      return {
        status: 200,
        space: {
          ...spaceRecording.space,
          spaceId: followingStorySpaceId,
          title: selectedTitle,
          ...(mode === 'reading-no-destination' ? { address: null, realmId: null } : {}),
        },
      };
    },
  },
  { method: 'GET', path: '/v1/follows', story: ({ request }) => list(request) },
  {
    method: 'DELETE',
    path: /^\/v1\/follows\/[^/]+$/,
    story: ({ request }) => {
      if (mode === 'unfollow-failure')
        return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
      const targetId = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!);
      const found = nativeRows().find((follow) => follow.targetId === targetId);
      if (!found) return { status: 404, code: 'not_found' };
      removed.add(targetId);
      const { target: _target, ...follow } = found;
      return { status: 200, follow: { ...follow, state: 'unfollowed' } };
    },
  },
];
