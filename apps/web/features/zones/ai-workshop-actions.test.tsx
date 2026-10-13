import { afterAll, expect, mock, test } from 'bun:test';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkCardSlotProps, ZoneCardLayout, ZonePackage } from '@rezics/zone-sdk';
import { localizedPath } from '../../i18n/locale.ts';
import { WorkshopCard } from '../../zones/official/ai-workshop/slots.tsx';
import { NO_PLATFORM_ACCESS, type PlatformAccess } from '../api/platform-access.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { OperationGate } from '../shell/operation-gate.tsx';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { zoneMessagesFor } from './fixtures.ts';
import { officialWorks, officialZone } from './official-fixtures.ts';
import { cardRenderer } from './zone-home.tsx';
import { installHostZoneAddresses } from './addresses.ts';

const originalHeaders = { ...(await import('next/headers')) };
const originalServerRead = { ...(await import('../api/server-read.ts')) };
let answer: PlatformAccess | 'unavailable' | 'malformed' = NO_PLATFORM_ACCESS;
let reads = 0;
await mock.module('next/headers', () => ({ ...originalHeaders,
  cookies: async () => ({ get: () => undefined }), headers: async () => new Headers(),
}));
await mock.module('../api/server-read.ts', () => ({ ...originalServerRead,
  serverRead: async (url: string) => {
    expect(new URL(url).pathname).toBe('/v1/me/platform-access');
    reads++;
    if (answer === 'unavailable') throw new Error('Main unavailable');
    return Response.json(answer === 'malformed' ? null : answer);
  },
}));
afterAll(async () => {
  await mock.module('next/headers', () => originalHeaders);
  await mock.module('../api/server-read.ts', () => originalServerRead);
});

// Resolve only the server card adapter; the real package and client Link still render below the shell.
async function resolveCard(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveCard));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    return resolveCard(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  }
  if (node.props.children === undefined) return node;
  const children = await resolveCard(node.props.children);
  return Array.isArray(children) ? cloneElement(node, {}, ...children) : cloneElement(node, {}, children);
}

const layouts: readonly ZoneCardLayout[] = ['cover', 'row', 'rail'];
const states = [
  { name: 'group open', access: { groups: ['developer-extras'], operations: [], generation: 'group' }, open: true },
  { name: 'operation open', access: { groups: [], operations: ['getV1HubWorksById'], generation: 'operation' }, open: true },
  { name: 'closed', access: NO_PLATFORM_ACCESS, open: false },
  { name: 'unrelated grant', access: { groups: [], operations: ['getV1Mod-releasesByWork'], generation: 'other' }, open: false },
  { name: 'unavailable access read', access: 'unavailable', open: false },
  { name: 'malformed access read', access: 'malformed', open: false },
] as const;

for (const locale of ['en', 'zh-Hans'] as const) {
  const zone = officialZone('ai-workshop', locale);
  const works = officialWorks('ai-workshop', locale, 'rich');
  for (const layout of layouts) {
    for (const kind of ['prompt', 'skill'] as const) {
      const work = works.find(item => item.hub?.kind === kind)!;
      for (const state of states) {
        test(`${locale} ${layout} ${kind} Try: ${state.name}`, async () => {
          answer = state.access;
          reads = 0;
          let supplied: WorkCardSlotProps | undefined;
          const pkg: ZonePackage = { slug: 'ai-workshop', css: '', slots: {
            workCard: props => { supplied = props; return <WorkshopCard {...props} />; },
          } };
          const card = await resolveCard(cardRenderer(zone, pkg, locale, zoneMessagesFor(locale))(work, { layout }));
          const access = typeof state.access === 'string' ? NO_PLATFORM_ACCESS : state.access;
          const html = renderToStaticMarkup(<ShellProvider locale={locale} messages={shellMessages}
            initialTheme="light" initialCollapsed={false} platformAccess={access}>{card}</ShellProvider>);
          expect(reads).toBe(1);
          expect(supplied?.Link).toBe(LocalizedLink);
          expect(supplied?.tryHref).toBe(state.open ? work.href : undefined);
          expect(Object.hasOwn(supplied!, 'tryHref')).toBe(state.open);
          const action = html.match(/<a\b[^>]*class="aw-try"[^>]*>[\s\S]*?<\/a>/)?.[0];
          expect(Boolean(action)).toBe(state.open);
          if (state.open) {
            expect(action).toContain(`href="${localizedPath(work.href, locale)}"`);
            expect(action).toContain(locale === 'en' ? 'Try it' : '试一试');
            expect(action).toContain(work.title!.value);
          }
          expect(html).toContain('class="aw-copy"');
          const existing = renderToStaticMarkup(<ShellProvider locale={locale} messages={shellMessages}
            initialTheme="light" initialCollapsed={false} platformAccess={access}>
            <OperationGate operation="getV1HubWorksById"><span>Try available</span></OperationGate>
          </ShellProvider>);
          expect(existing.includes('Try available')).toBe(Boolean(action));
        });
      }
    }
    for (const hub of [null, undefined]) {
      test(`${locale} ${layout} non-Hub Try with ${hub === null ? 'null' : 'omitted'} Hub`, async () => {
        answer = 'unavailable';
        reads = 0;
        const work = { ...works.find(item => !item.hub)!, hub };
        let supplied: WorkCardSlotProps | undefined;
        const pkg: ZonePackage = { slug: 'ai-workshop', css: '', slots: {
          workCard: props => { supplied = props; return <WorkshopCard {...props} />; },
        } };
        const card = await resolveCard(cardRenderer(zone, pkg, locale, zoneMessagesFor(locale))(work, { layout }));
        const html = renderToStaticMarkup(<ShellProvider locale={locale} messages={shellMessages}
          initialTheme="light" initialCollapsed={false} platformAccess={NO_PLATFORM_ACCESS}>{card}</ShellProvider>);
        expect(reads).toBe(0);
        expect(Object.hasOwn(supplied!, 'tryHref')).toBe(false);
        const action = html.match(/<a\b[^>]*class="aw-try"[^>]*>[\s\S]*?<\/a>/)?.[0];
        expect(action).toContain(`href="${localizedPath(work.href, locale)}"`);
        expect(html).toContain('class="aw-copy"');
      });
    }
  }
}

test('a Hub card uses the supplied Try destination rather than its ordinary Work link', () => {
  installHostZoneAddresses();
  const zone = officialZone('ai-workshop', 'en');
  const work = officialWorks('ai-workshop', 'en', 'rich').find(item => item.hub)!;
  const tryHref = `${work.href}?version=published`;
  const html = renderToStaticMarkup(<WorkshopCard zone={zone} work={work} layout="cover"
    fallback={null} nextVolume={null} Link={LocalizedLink} tryHref={tryHref} />);
  const action = html.match(/<a\b[^>]*class="aw-try"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(action).toContain(`href="${localizedPath(tryHref, 'en')}"`);
});
