import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScreenEpisodeList } from '../src/features/catalogue/screen-episode-reader/view';
import { readScreenEpisodePage } from '../src/features/catalogue/screen-episode-reader/read';
import { screenEpisodeReturnHref } from '../src/features/catalogue/screen-episode-reader/navigation';
import { subjectHref } from '../src/subject/subject-href';
import { screenProfileFixture } from '../src/kernel/fake/catalogue-screen-profile';

const seasonId = '00000000-0000-4000-8000-000000000902';
const specialId = '00000000-0000-4000-8000-000000000903';
const realmId = '00000000-0000-4000-8000-000000000904';

test('screen work parts keep canonical season and special identities, native positions and exact list return', async () => {
  const fixture = screenProfileFixture('ready', 'en', true, 'schema:TVSeries');
  const profile = await fixture.transport.load();
  if (!profile.ok || !profile.public) throw new Error('Expected a current Screen profile');
  const queries: unknown[] = [];
  const client = {
    subjects: ({ id }: { id: string }) => ({
      links: {
        get: async ({ query }: { query: Record<string, unknown> }) => {
          queries.push({ id, ...query });
          return {
            status: 200,
            data: {
              count: { value: 2, exact: true },
              next: null,
              links: [
                {
                  subject: seasonId,
                  statement: 'membership-season',
                  assertion: {
                    id: 'membership-season',
                    qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '1' } }],
                  },
                  summary: { id: seasonId, type: 'schema:TVSeason', label: { value: 'Season One', language: 'en' } },
                },
                {
                  subject: specialId,
                  statement: 'membership-special',
                  assertion: {
                    id: 'membership-special',
                    qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: 'SP 1' } }],
                  },
                  summary: { id: specialId, type: 'schema:Episode', label: { value: 'The Special', language: 'en' } },
                },
              ],
            },
          };
        },
      },
    }),
  } as unknown as KernelClient;

  const read = await readScreenEpisodePage(client, profile.release, profile.public, 'en', realmId, 'opaque-page-two');
  expect(queries).toEqual([
    {
      id: profile.public.subject.id,
      property: 'schema:isPartOf',
      language: 'en',
      limit: 20,
      context: realmId,
      cursor: 'opaque-page-two',
    },
  ]);
  expect(read).toMatchObject({
    ok: true,
    state: 'ready',
    entries: [
      { id: seasonId, type: 'schema:TVSeason', position: '1' },
      { id: specialId, type: 'schema:Episode', position: 'SP 1' },
    ],
    next: null,
  });

  const list = subjectHref({ id: profile.public.subject.id, label: 'The Observatory' }, 'en').href;
  const origin = { pathname: list, searchStr: `?realm=${realmId}&screenCursor=opaque-page-two` };
  const html = renderToStaticMarkup(<ScreenEpisodeList locale="en" read={read} origin={origin} />);
  expect(html).toContain(`/en/subjects/${seasonId}/season-one`);
  expect(html).toContain(`/en/subjects/${specialId}/the-special`);
  expect(html).toContain('SP 1');
  expect(html).not.toMatch(/type="checkbox"|aria-checked|Mark watched|completed/i);
  expect(html).not.toContain('/library/progress');

  const specialHrefValue = html.match(/href="([^"]*the-special[^"]*)"/)?.[1];
  if (!specialHrefValue) throw new Error('Expected a canonical Episode link');
  const specialHref = new URL(specialHrefValue.replaceAll('&amp;', '&'), 'https://site.invalid');
  const returnHref = screenEpisodeReturnHref('en', specialHref.search);
  expect(returnHref).toBe(`${list}?screenCursor=opaque-page-two&realm=${realmId}#screen-episode-list`);
});
