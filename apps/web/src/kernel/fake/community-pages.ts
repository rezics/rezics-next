import type { FakeRoute } from '../fake-modules.ts';

const spaceId = '01a1a000-0000-7000-8000-000000000001';
const realmId = '01a1a000-0000-7000-8000-000000000002';
let pageVariant: 'banner' | 'plain' | 'member' | 'non-member' = 'banner';
const banner = {
  media: '01a1a000-0000-7000-8000-000000000080',
  width: 1600,
  height: 640,
  placeholder: { thumbhash: '', color: '#252a31' },
  variants: [{ format: 'webp' as const, width: 320 }],
  focalPoint: { x: 0.5, y: 0.42 },
  credit: null,
};

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/spaceAddresses\/(atlas-banner|atlas-plain|atlas-member|atlas-non-member)$/,
    story: ({ match }) => {
      const address = match?.[1];
      pageVariant =
        address === 'atlas-plain'
          ? 'plain'
          : address === 'atlas-member'
            ? 'member'
            : address === 'atlas-non-member'
              ? 'non-member'
              : 'banner';
      return { status: 200, spaceId };
    },
  },
  {
    method: 'GET',
    path: `/v1/spaces/${spaceId}`,
    story: ({ recordings }) => {
      const read = recordings.space;
      if (!read || !read.space || typeof read.space !== 'object') return;
      return pageVariant === 'plain' ? read : { ...read, space: { ...read.space, banner } };
    },
  },
  {
    method: 'GET',
    path: `/v1/realms/${realmId}/members/me`,
    story: ({ recordings }) =>
      pageVariant === 'member'
        ? { status: 200, state: 'member', since: '2026-10-26T18:22:28.427Z' }
        : recordings['realm-member'],
  },
  {
    method: 'GET',
    path: '/v1/me/realms',
    story: ({ recordings }) => {
      const read = recordings['my-realms'];
      if (!read || !Array.isArray(read.items)) return;
      return {
        ...read,
        items: read.items.map((item, index) =>
          item && typeof item === 'object'
            ? {
                ...item,
                description:
                  index === 0
                    ? 'A welcoming table for patient readers, long conversations, and notes worth keeping.'
                    : undefined,
              }
            : item,
        ),
      };
    },
  },
  {
    method: 'GET',
    path: `/v1/realms/${realmId}/boards`,
    story: ({ recordings }) => {
      const read = recordings['realm-boards'];
      if (!read || !Array.isArray(read.items)) return;
      return {
        ...read,
        items: read.items.map((item, index) =>
          item && typeof item === 'object'
            ? {
                ...item,
                description:
                  index === 0
                    ? 'Share what you are reading, what stayed with you, and what you would pass along.'
                    : undefined,
              }
            : item,
        ),
      };
    },
  },
];
