import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/button';
import { NO_PLATFORM_ACCESS, type PlatformAccess } from '../api/platform-access.ts';
import { PrimaryAction as FeedAction } from '../feed/actions.tsx';
import { FeedProvider } from '../feed/feed-context.tsx';
import { everyKind, NOW } from '../feed/fixtures.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PrimaryAction as ShowcaseAction } from '../showcase/work-action.tsx';
import { officialWorks, officialZone } from '../zones/official-fixtures.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { installHostZoneAddresses } from '../zones/addresses.ts';
import { WorkshopCard } from '../../zones/official/ai-workshop/slots.tsx';
import workshopCss from '../../zones/official/ai-workshop/ai-workshop.css?raw';

const works = officialWorks('ai-workshop', 'en', 'rich');
const skill = works.find(work => work.hub?.kind === 'skill')!;
const prompt = works.find(work => work.hub?.kind === 'prompt')!;
const zone = officialZone('ai-workshop', 'en');
const hubItems = everyKind.filter(item => ['install', 'copy-prompt'].includes(item.primaryAction.kind));
const granted: PlatformAccess = { groups: ['developer-extras'], operations: [], generation: 'group' };
const operationGranted: PlatformAccess = { groups: [], operations: ['getV1HubWorksById'], generation: 'operation' };

/** The three entry contexts retain public work information when the Hub instruction read closes. */
function HubEntries({ access = NO_PLATFORM_ACCESS, signedIn = true, revoke = false }: {
  access?: PlatformAccess; signedIn?: boolean; revoke?: boolean;
}) {
  installHostZoneAddresses();
  const [current, setCurrent] = useState(access);
  return <ShellProvider locale="en" messages={shellMessages} initialTheme="light" initialCollapsed={false}
    signedIn={signedIn} platformAccess={current}>
    <main className="mx-auto grid max-w-4xl gap-8 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-semibold text-2xl">Prompts and skills</h1>
        {revoke ? <Button variant="outline" onClick={() => setCurrent({ ...NO_PLATFORM_ACCESS, generation: 'revoked' })}>
          Revoke access</Button> : null}
      </header>
      <section aria-label="Feed actions" className="grid gap-3">
        <h2 className="font-semibold text-lg">From your feed</h2>
        <FeedProvider locale="en" messages={feedMessages} now={NOW} signedIn={signedIn}
          actingSubject={null} signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null}>
          {hubItems.map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <LocalizedLink href={item.links.target} className="font-medium">{item.target.title.value}</LocalizedLink>
            <FeedAction item={item} title={item.target.title.value} />
          </article>)}
        </FeedProvider>
      </section>
      <section aria-label="Featured actions" className="grid gap-3">
        <h2 className="font-semibold text-lg">Featured picks</h2>
        <div className="grid gap-4 sm:grid-cols-2">{[skill, prompt].map(work => <article key={work.id}
          className="grid content-start gap-3 rounded-xl border p-4">
          <h3 className="font-medium"><LocalizedLink href={work.href}>{work.title!.value}</LocalizedLink></h3>
          <div><ShowcaseAction work={work} locale="en" messages={zoneMessagesFor('en')} /></div>
        </article>)}</div>
      </section>
      <section aria-label="Workshop actions" data-zone="ai-workshop" className="grid gap-3">
        <style>{workshopCss}</style>
        <h2 className="font-semibold text-lg">AI Workshop</h2>
        <div className="grid gap-4 sm:grid-cols-2">{[skill, prompt].map(work => <WorkshopCard key={work.id}
          work={work} zone={zone} Link={LocalizedLink} layout="cover" nextVolume={null} fallback={null} />)}</div>
      </section>
    </main>
  </ShellProvider>;
}

const meta = { title: 'Work/Hub access', component: HubEntries,
  parameters: { layout: 'fullscreen' }, args: { access: NO_PLATFORM_ACCESS, signedIn: true },
} satisfies Meta<typeof HubEntries>;
export default meta;
type Story = StoryObj<typeof meta>;

async function denied(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.queryByRole('link', { name: 'Install' })).toBeNull();
  await expect(canvas.queryByRole('link', { name: 'Use prompt' })).toBeNull();
  await expect(canvas.queryByRole('link', { name: /^Try it/ })).toBeNull();
  await expect(canvas.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^Copy Skill/ })).toBeVisible();
  await expect(canvas.getAllByRole('link', { name: skill.title!.value }).length).toBeGreaterThan(0);
}
async function allowed(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole('link', { name: 'Install' })).toHaveLength(2);
  await expect(canvas.getByRole('link', { name: 'Use prompt' })).toBeVisible();
  await expect(canvas.getAllByRole('link', { name: /^Try it/ })).toHaveLength(2);
}

export const Anonymous: Story = { args: { signedIn: false }, play: ({ canvasElement }) => denied(canvasElement) };
export const SignedInWithoutGrant: Story = { play: ({ canvasElement }) => denied(canvasElement) };
export const GroupGrant: Story = { args: { access: granted }, play: ({ canvasElement }) => allowed(canvasElement) };
export const OperationGrant: Story = {
  args: { access: operationGranted }, play: ({ canvasElement }) => allowed(canvasElement),
};
export const UnrelatedOperationGrant: Story = {
  args: { access: { groups: [], operations: ['getV1Mod-releasesByWork'], generation: 'unrelated' } },
  play: ({ canvasElement }) => denied(canvasElement),
};
export const Revoked: Story = {
  args: { access: granted, revoke: true },
  async play({ canvasElement }) {
    await allowed(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Revoke access' }));
    await denied(canvasElement);
  },
};
