import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformAccess } from '../api/platform-access.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { PrimaryAction as FeedAction } from '../feed/actions.tsx';
import { everyKind, NOW } from '../feed/fixtures.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { PrimaryAction as ShowcaseAction } from '../showcase/work-action.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { officialWorks, officialZone } from '../zones/official-fixtures.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { installHostZoneAddresses } from '../zones/addresses.ts';
import { WorkshopCard } from '../../zones/official/ai-workshop/slots.tsx';

installHostZoneAddresses();
const works = officialWorks('ai-workshop', 'en', 'rich');
const skill = works.find(work => work.hub?.kind === 'skill')!;
const prompt = works.find(work => work.hub?.kind === 'prompt')!;
const zone = officialZone('ai-workshop', 'en');
const install = everyKind.find(item => item.primaryAction.kind === 'install')!;
const usePrompt = everyKind.find(item => item.primaryAction.kind === 'copy-prompt')!;
const publicRead = everyKind.find(item => item.primaryAction.kind === 'read-chapter')!;

function draw(children: ReactNode, access: PlatformAccess, signedIn: boolean) {
  return renderToStaticMarkup(<ShellProvider locale="en" messages={shellMessages} initialTheme="light"
    initialCollapsed={false} signedIn={signedIn} platformAccess={access}>{children}</ShellProvider>);
}
function feed(children: ReactNode, signedIn: boolean) {
  return <FeedProvider locale="en" messages={feedMessages} now={NOW} signedIn={signedIn}
    actingSubject={null} signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null}>
    {children}</FeedProvider>;
}

for (const state of [
  { name: 'anonymous', signedIn: false, groups: [], operations: [], permitted: false },
  { name: 'signed in without a grant', signedIn: true, groups: [], operations: [], permitted: false },
  { name: 'group grant', signedIn: true, groups: ['developer-extras'], operations: [], permitted: true },
  { name: 'individual operation grant', signedIn: true, groups: [], operations: ['getV1HubWorksById'], permitted: true },
  { name: 'unrelated individual grant', signedIn: true, groups: [], operations: ['getV1Mod-releasesByWork'], permitted: false },
  { name: 'revoked grant', signedIn: true, groups: [], operations: [], permitted: false },
]) {
  const access = { groups: state.groups, operations: state.operations, generation: state.name };
  test(`feed install and prompt actions: ${state.name}`, () => {
    const html = draw(feed(<><FeedAction item={install} title="Skill" />
      <FeedAction item={usePrompt} title="Prompt" /><FeedAction item={publicRead} title="Chapter" /></>, state.signedIn),
    access, state.signedIn);
    expect(html.includes('>Install</a>')).toBe(state.permitted);
    expect(html.includes('>Use prompt</a>')).toBe(state.permitted);
    expect(html).toContain('Read chapter');
  });
  test(`showcase keeps local prompt copy while gating skill install: ${state.name}`, () => {
    const html = draw(<><ShowcaseAction work={skill} locale="en" messages={zoneMessagesFor('en')} />
      <ShowcaseAction work={prompt} locale="en" messages={zoneMessagesFor('en')} /></>, access, state.signedIn);
    expect(html.includes('>Install</a>')).toBe(state.permitted);
    expect(html).toContain('Copy prompt');
  });
  // Host-approved Try destinations are covered by zones/ai-workshop-actions.test.tsx.
  test(`workshop keeps copy text and public detail links without a host Try destination: ${state.name}`, () => {
    const html = draw(<WorkshopCard work={skill} zone={zone} Link={LocalizedLink} layout="cover"
      nextVolume={null} fallback={null} />, access, state.signedIn);
    expect(html).not.toContain('class="aw-try"');
    expect(html).toContain('Copy Skill');
    expect(html).toContain(skill.title!.value);
    expect(html).toContain(`href="/en${skill.href}"`);
  });
}

test('an ordinary workshop pick retains its public Try it action without any grant', () => {
  const html = draw(<WorkshopCard work={{ ...skill, hub: null }} zone={zone} Link={LocalizedLink}
    layout="cover" nextVolume={null} fallback={null} />, { groups: [], operations: [], generation: '' }, false);
  expect(html).toContain('class="aw-try"');
});

test('an ordinary package retains its public work action without a Hub grant', () => {
  const html = draw(<ShowcaseAction work={{ ...skill, kind: 'package', hub: null }} locale="en"
    messages={zoneMessagesFor('en')} />, { groups: [], operations: [], generation: '' }, false);
  expect(html).toContain('>Install</a>');
});
