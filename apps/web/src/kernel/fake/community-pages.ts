import type { FakeRoute } from '../fake-modules.ts';

const spaceId = '01a1a000-0000-7000-8000-000000000001';
const realmId = '01a1a000-0000-7000-8000-000000000002';
let pageVariant: 'banner' | 'plain' | 'member' | 'non-member' | 'unavailable' | 'boards-unavailable' = 'banner';
const bannerPreview = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 640"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="#132c3a"/><stop offset=".52" stop-color="#28645d"/><stop offset="1" stop-color="#b68d68"/></linearGradient><linearGradient id="mist" x2="0" y2="1"><stop stop-color="#f5e6c8" stop-opacity=".04"/><stop offset="1" stop-color="#f5e6c8" stop-opacity=".34"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h1600v640H0z"/><circle cx="1260" cy="105" r="155" fill="#f2d9a3" fill-opacity=".54"/><path fill="#153b3c" d="M0 425 225 265l170 143 224-230 255 248 195-188 274 217 257-164v349H0z"/><path fill="#275453" d="m0 493 254-151 214 128 205-175 250 183 199-142 239 169 239-153v288H0z"/><path fill="url(#mist)" d="M0 380h1600v260H0z"/></svg>',
)}`;
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
    path: /^\/v1\/spaceAddresses\/(atlas-banner|atlas-plain|atlas-member|atlas-non-member|atlas-unavailable|atlas-boards-unavailable)$/,
    story: ({ match }) => {
      const address = match?.[1];
      pageVariant =
        address === 'atlas-plain'
          ? 'plain'
          : address === 'atlas-member'
            ? 'member'
            : address === 'atlas-non-member'
              ? 'non-member'
              : address === 'atlas-unavailable'
                ? 'unavailable'
                : address === 'atlas-boards-unavailable'
                  ? 'boards-unavailable'
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
      return pageVariant === 'plain'
        ? read
        : { ...read, space: { ...read.space, banner: { ...banner, previewSrc: bannerPreview } } };
    },
  },
  {
    method: 'GET',
    path: `/v1/realms/${realmId}/members/me`,
    story: ({ recordings }) => {
      if (pageVariant === 'member') return { status: 200, state: 'member', since: '2026-10-26T18:22:28.427Z' };
      // Failure injection only: preserve the native Problem shape while making this personal read unavailable.
      if (pageVariant === 'unavailable')
        return {
          status: 503,
          type: 'https://rezics.test/problems/overloaded',
          title: 'Service Unavailable',
          detail: 'Membership status is temporarily unavailable.',
        };
      return recordings['realm-member'];
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/[^/]+$/,
    story: () =>
      pageVariant === 'unavailable'
        ? {
            status: 404,
            type: 'https://rezics.test/problems/not_found',
            title: 'Not Found',
            detail: 'The published subject is not available.',
          }
        : undefined,
  },
  {
    method: 'GET',
    path: '/v1/me/realms',
    story: ({ recordings }) => {
      const read = recordings['my-realms'];
      if (!read || !Array.isArray(read.items)) return;
      return read;
    },
  },
  {
    method: 'GET',
    path: `/v1/realms/${realmId}/boards`,
    story: ({ recordings }) => {
      // Failure injection only: a native-shaped 503 must surface as an error, never as an empty board list.
      if (pageVariant === 'boards-unavailable')
        return {
          status: 503,
          type: 'https://rezics.test/problems/overloaded',
          title: 'Service Unavailable',
          detail: 'Realm boards are temporarily unavailable.',
        };
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
