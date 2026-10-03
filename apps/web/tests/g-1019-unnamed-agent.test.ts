import { expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { profileHref } from '../features/profile/route.ts';
import { profileJsonLd, profileMetadata } from '../features/profile/metadata.ts';
import { storyProfile, storyId } from '../features/profile/fixtures.ts';
import { messages } from '../features/profile/messages.ts';
import { studioHref, resolveStudioAgent } from '../features/studio/agent.ts';
import { shownHandle } from '../features/manage/format.ts';
import { currentVanityHandle } from '../features/onboarding/handle.ts';
import { authorHref } from '../features/author/route.ts';
import { identityHref } from '../features/address/path.ts';
import type { AgentOption } from '../features/auth/acting-identity.ts';

test('G-1019: unnamed profiles and attribution keep a display name and opaque links without a username', () => {
  const profile = storyProfile({ handle: null });
  const href = identityHref('/a/', profile.id);
  expect(profileHref(profile)).toBe(href);
  expect(profileHref(profile, { kind: 'works' }, 'next')).toBe(`${href}/works?cursor=next`);
  expect(authorHref({ kind: 'agent', handle: null, agent: profile.id })).toBe(href);
  const metadata = profileMetadata(profile, true, 'en', messages);
  expect(metadata.title).toBe(profile.displayName);
  expect(metadata.openGraph).not.toHaveProperty('username');
  expect(JSON.parse(profileJsonLd(profile, null)).mainEntity).not.toHaveProperty('alternateName');
  expect(currentVanityHandle(null)).toBeNull();
  expect(shownHandle(null)).toBeNull();
  expect(shownHandle('agent-smith')).toBe('@agent-smith');
});

test('G-1019: Studio uses case-sensitive sids and resolves its previous UUID addresses', () => {
  const option: AgentOption = {
    iri: storyId(1),
    label: 'Lin Mei',
    handle: null,
    kind: 'person',
    path: 'direct-principal',
  };
  const sid = uuidToSid(option.iri.slice(-36));
  expect(studioHref(option)).toBe(`/studio/@${sid}`);
  for (const key of [sid, option.iri.slice(-36), `agent-${option.iri.slice(-36)}`]) {
    expect(resolveStudioAgent(`@${key}`, [option])).toEqual({ kind: 'agent', agent: option });
  }
  expect(resolveStudioAgent(`@${sid.toLowerCase()}`, [option])).not.toEqual({
    kind: 'agent',
    agent: option,
  });
  expect(studioHref({ ...option, handle: 'lin_mei' })).toBe('/studio/@lin_mei');
  expect(profileHref(`agent-${option.iri.slice(-36)}`)).toBe(identityHref('/a/', option.iri));
});
