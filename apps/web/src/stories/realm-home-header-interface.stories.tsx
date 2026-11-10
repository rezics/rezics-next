import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { expect, userEvent, within } from 'storybook/test';
import { RealmHomeHeader } from '../community/realm-home-header';
import { loadSpacePage } from '../community/space';
import type { RealmAppearanceSnapshot } from '../community/realm-presentation';
import {
  appearanceAddress,
  appearancePath,
  appearanceRecording,
  available,
  configured,
  image,
  bannerImage,
} from '../kernel/fake/community';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const title = `A reading room for every interpretation — ${'UnbrokenRealmTitle'.repeat(10)}`;
const description = `${'Read together, compare interpretations, and make room for other readers. '.repeat(12)}\n${'UnbrokenDescription'.repeat(18)}\nThe final supplied description stays readable.`;
const spaceSummary = `${'This Space introduces the community and its reading programme. '.repeat(8)}\nThe final supplied Space summary stays readable.`;
const rulesText = `${'Mark spoilers and discuss the work with care. '.repeat(24)}\n${'UnbrokenRule'.repeat(18)}\nThe final supplied rule stays readable.`;
const firstNote = `First reader's local reading note — ${'LongParticipationLabel'.repeat(6)}`;
const secondNote = `Second reader's local reading note — ${'LongParticipationLabel'.repeat(6)}`;
const avatarHolder = `Avatar illustrator — ${'UnbrokenCredit'.repeat(14)}`;
const bannerHolder = `Banner photographer — ${'UnbrokenCredit'.repeat(14)}`;
const states = [
  'available',
  'no-images',
  'optional-unavailable',
  'source-unavailable',
  'current-denied',
  'orphan-readable',
  'protected-denied',
  'removed',
] as const;
type State = (typeof states)[number];

// Explicit native-shaped responses traverse the actual page and presentation adapters.
// These examples add no session, member count, command admission or native evidence.
async function loadExample(state: State) {
  const fields: Pick<RealmAppearanceSnapshot, 'avatar' | 'banner' | 'rules'> =
    state === 'optional-unavailable'
      ? {
          avatar: { state: 'none', value: null },
          banner: { state: 'unavailable', value: null },
          rules: { state: 'unavailable', value: null },
        }
      : state === 'no-images'
        ? configured
        : {
            avatar: {
              state: 'available',
              value: {
                ...image,
                credit: {
                  rightsHolder: avatarHolder,
                  via: { name: 'Avatar original source', url: 'https://example.org/avatar' },
                  license: 'CC-BY-4.0',
                  obligations: ['cc:Attribution'],
                },
              },
            },
            banner: {
              state: 'available',
              value: {
                ...bannerImage,
                credit: {
                  rightsHolder: bannerHolder,
                  via: { name: 'Banner original source', url: 'https://example.org/banner' },
                  license: 'CC-BY-SA-4.0',
                  obligations: ['cc:Attribution', 'cc:ShareAlike'],
                },
              },
            },
            rules: {
              state: 'available',
              value: { ...available.presentation.rules!, title: 'Reading room rules', summary: rulesText },
            },
          };
  const snapshot: RealmAppearanceSnapshot = {
    ...(state === 'no-images' ? configured : available),
    title,
    ...fields,
  };
  const calls: string[] = [];
  let realmReads = 0;
  const client = createKernelClient('https://kernel.story', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        if (path === `/v1/realms/${available.realmId}`) {
          realmReads++;
          if (state === 'protected-denied') return Response.json({ code: 'not_found' }, { status: 404 });
        }
        if (path.endsWith('/presentation') && (state === 'source-unavailable' || state === 'current-denied'))
          return new Response(null, { status: state === 'current-denied' ? 403 : 503 });
        const response = await appearanceRecording(request, snapshot);
        if (!response) throw new Error(`Unexpected header request: ${request.method} ${path}`);
        if (response.realm && typeof response.realm === 'object')
          response.realm = {
            ...response.realm,
            summary: description,
            ...(state === 'orphan-readable'
              ? {
                  ownershipState: 'orphaned',
                  orphanedAt: '2026-09-01T00:00:00.000Z',
                  claimEligibleAt: '2026-10-01T00:00:00.000Z',
                  governanceReadOnly: true,
                }
              : {}),
            ...(state === 'removed' && realmReads > 1 ? { state: 'removed' } : {}),
          };
        if (response.space && typeof response.space === 'object')
          response.space = {
            ...response.space,
            title: 'A distinct Space for long reading programmes',
            summary: spaceSummary,
          };
        if (response.community && typeof response.community === 'object')
          response.community = { ...response.community, description };
        return Response.json(response);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const page = await loadSpacePage(
    client,
    new Request(`https://site.story/en${appearancePath}`),
    {},
    { address: appearanceAddress },
    'anonymous',
  );
  return { state, page, calls };
}

function HeaderExamples() {
  const query = useQuery({
    queryKey: ['realm-home-header-interface'],
    queryFn: () => Promise.all(states.map(loadExample)),
  });
  if (!query.data) return <p role="status">{m.realm_shelf_unavailable()}</p>;
  const first = query.data[0]!.page;
  if (!first.realm) throw new Error('The recorded header has no Realm');
  return (
    <div className="grid min-w-0 gap-8 p-4 md:grid-cols-2">
      <div data-header-case="first" className="min-w-0 max-w-[390px]">
        <RealmHomeHeader
          realm={first.realm}
          space={first.space}
          participation={
            <details>
              <summary className="min-h-11 cursor-pointer rounded-md py-3 focus-visible:outline-2 focus-visible:outline-ring">
                {firstNote}
              </summary>
              <p>First reader's supplied note.</p>
            </details>
          }
        />
      </div>
      <div data-header-case="second" dir="rtl" className="min-w-0 max-w-[390px]">
        <RealmHomeHeader
          realm={first.realm}
          space={{ title, summary: spaceSummary }}
          participation={
            <details>
              <summary className="min-h-11 cursor-pointer rounded-md py-3 focus-visible:outline-2 focus-visible:outline-ring">
                {secondNote}
              </summary>
              <p>Second reader's supplied note.</p>
            </details>
          }
        />
      </div>
      {query.data.slice(1).map(({ state, page }) =>
        page.realm ? (
          <div key={state} data-header-case={state} dir="rtl" className="min-w-0 max-w-[390px]">
            <RealmHomeHeader realm={page.realm} space={page.space} />
          </div>
        ) : null,
      )}
      <RealmHomeHeader
        realm={{
          ...first.realm,
          title: 'Withheld Realm identity',
          summary: 'Withheld description',
          presentation: { state: 'hidden', value: null },
        }}
        space={{ title: 'Withheld Space identity', summary: 'Withheld Space summary' }}
        participation={<p>Withheld participation</p>}
      />
    </div>
  );
}

const meta = {
  title: 'Community/Realm Home Header Interface',
  id: 'patterns-community-realm-home-header-interface',
  component: RealmHomeHeader,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual headers for the same Realm, independent local children, long supplied content, exact sources and native unavailable/hidden states. All plays are authored UNRUN; phone390/RTL, keyboard, browser and native proof remain owed.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof RealmHomeHeader>;
export default meta;
type Story = StoryObj;

export const IndependentHeaders: Story = {
  render: () => (
    <PatternStory path={appearancePath}>
      <HeaderExamples />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findAllByRole('heading', { level: 2, name: title });
    const headers = Array.from(canvasElement.querySelectorAll<HTMLElement>('[data-slot="realm-home-presentation"]'));
    await expect(headers).toHaveLength(6);
    const ids: string[] = [];
    for (const header of headers) {
      const heading = header.querySelector('h1[id], h2[id]')!;
      const rules = within(header).getByRole('region', { name: m.board_community_rules() });
      const rulesHeading = within(rules).getByRole('heading', { level: 3, name: m.board_community_rules() });
      await expect(header).toHaveAttribute('aria-labelledby', heading.id);
      await expect(rules).toHaveAttribute('aria-labelledby', rulesHeading.id);
      for (const element of [heading, rulesHeading]) {
        await expect(canvasElement.ownerDocument.getElementById(element.id)).toBe(element);
        ids.push(element.id);
      }
      await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
      await expect(within(header).getByText(m.board_community_members_unknown())).toBeVisible();
      await expect(header.querySelector('[class*="line-clamp"], [class*="truncate"]')).toBeNull();
    }
    await expect(new Set(ids).size).toBe(ids.length);
    const first = canvasElement.querySelector<HTMLElement>('[data-header-case="first"]')!;
    const second = canvasElement.querySelector<HTMLElement>('[data-header-case="second"]')!;
    await expect(within(first).getByRole('heading', { level: 1 })).toHaveTextContent(
      'A distinct Space for long reading programmes',
    );
    await expect(within(second).getByRole('heading', { level: 1 })).toHaveTextContent(title);
    await expect(within(second).queryByRole('heading', { level: 2 })).toBeNull();
    const link = within(first).getByRole('link', { name: title });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/realms/${available.realmId}`);
    await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    link.focus();
    await expect(link).toHaveFocus();
    for (const header of [first, second]) {
      await expect(header.textContent).toContain(description);
      for (const paragraph of rulesText.split('\n')) await expect(header.textContent).toContain(paragraph);
      await expect(within(header).getByRole('link', { name: m.board_community_rules_revision() })).toHaveAttribute(
        'href',
        `/${getLocale()}/posts/${available.presentation.rules!.postId}/revisions/${available.presentation.rules!.revisionId}`,
      );
      for (const [name, url, holder, license] of [
        ['Avatar original source', 'https://example.org/avatar', avatarHolder, 'CC-BY-4.0'],
        ['Banner original source', 'https://example.org/banner', bannerHolder, 'CC-BY-SA-4.0'],
      ] as const) {
        await expect(within(header).getByRole('link', { name })).toHaveAttribute('href', url);
        await expect(header.textContent).toContain(holder);
        await expect(header.textContent).toContain(license);
      }
    }
    await expect(first.textContent).toContain(spaceSummary);
    const firstDisclosure = first.querySelector('details')!;
    const secondDisclosure = second.querySelector('details')!;
    firstDisclosure.querySelector('summary')!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(firstDisclosure).toHaveAttribute('open');
    await expect(secondDisclosure).not.toHaveAttribute('open');
    await userEvent.click(secondDisclosure.querySelector('summary')!);
    await expect(secondDisclosure).toHaveAttribute('open');
    await expect(firstDisclosure).toHaveAttribute('open');
    await userEvent.click(firstDisclosure.querySelector('summary')!);
    await expect(firstDisclosure).not.toHaveAttribute('open');
    await expect(secondDisclosure).toHaveAttribute('open');
    const optional = canvasElement.querySelector<HTMLElement>('[data-header-case="optional-unavailable"]')!;
    for (const text of [
      m.realm_appearance_no_image(),
      m.realm_appearance_image_unavailable(),
      m.board_community_rules_unavailable(),
    ])
      await expect(within(optional).getByText(text)).toBeVisible();
    const source = canvasElement.querySelector<HTMLElement>('[data-header-case="source-unavailable"]')!;
    await expect(within(source).getByRole('status')).toHaveTextContent(m.board_community_source_unavailable());
    for (const state of ['current-denied', 'removed'])
      await expect(canvasElement.querySelector(`[data-header-case="${state}"]`)?.childElementCount).toBe(0);
    await expect(canvasElement.textContent).not.toContain('Withheld');
    await expect(
      canvasElement.querySelector('[data-member-state], a[href*="/auth/"], a[href*="/access/"], button'),
    ).toBeNull();
    for (const label of [
      m.realm_join(),
      m.realm_leave(),
      m.community_manage(),
      m.space_setup_entry(),
      m.realm_appearance_heading(),
    ])
      await expect(view.queryByText(label)).toBeNull();
  },
};
