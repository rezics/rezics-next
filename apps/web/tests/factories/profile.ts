import type { KernelClient } from '@rezics/client';
import { officialProfileRead, type EditableProfileRead } from '../../src/settings/editable-profile-source';
import type { ProfileValues } from '../../src/settings/profile-data';

type Envelope = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['accounts']>['profile']['get']>>['data']>;
type Profile = Envelope['profile'];

export function editableProfile({
  id = '019a0000-0000-7000-8000-000000000001',
  handle = null,
  displayName = 'Native name',
  bio = 'Native notes',
  avatar = null,
  links = [],
  publicViews = { posts: false, reviews: true, collections: false, realms: true },
}: {
  id?: Profile['id'];
  handle?: Profile['handle'];
  displayName?: Profile['displayName'];
  bio?: Profile['bio'];
  avatar?: Profile['avatar'];
  links?: Profile['links'];
  publicViews?: Profile['publicViews'];
} = {}): Profile {
  return {
    id,
    kind: 'actor',
    handle,
    displayName,
    bio,
    avatar: structuredClone(avatar),
    links: links.map((link) => ({ ...link })),
    publicViews: { ...publicViews },
  };
}

/** The installed `{ profile, editing }` observation, typed by the producer rather than the client's profile-only read. */
export function profileEnvelope(profile = editableProfile()): EditableProfileRead {
  return officialProfileRead(structuredClone(profile));
}

export function profileAvatar(): NonNullable<Profile['avatar']> {
  return {
    media: '019a0000-0000-7000-8000-000000000002',
    width: 80,
    height: 80,
    placeholder: { thumbhash: 'hash', color: '#123456' },
    variants: [{ format: 'webp', width: 80 }],
    focalPoint: null,
    credit: null,
  };
}

export function profileValues(native = editableProfile()): ProfileValues {
  return {
    accountId: native.id,
    kind: native.kind,
    displayName: native.displayName,
    biography: native.bio,
    avatar: structuredClone(native.avatar),
    links: structuredClone(native.links),
    publicViews: { ...native.publicViews },
    ...(native.speakersListed === undefined ? {} : { speakersListed: native.speakersListed }),
  };
}
