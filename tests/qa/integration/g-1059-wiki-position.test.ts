import { expect, test } from 'bun:test';
import { SeedApi, type SeedEndpoints } from '../../../scripts/dev/seed/api.ts';
import {
  applyOfficialWiki,
  wikiChapterLabels,
  wikiZone,
} from '../../../scripts/dev/seed/official-wiki-step.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import {
  backfillOccurrenceLabels,
  occurrenceLabelReadiness,
} from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import {
  positionPickerPage,
  type ReadingPositionPage,
} from '../../../apps/web/features/wiki/position-picker.ts';
import { mainPosition, parsePosition } from '../../../apps/web/features/wiki/position.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);

test('G1059: the replayed official wiki seed finds and resolves the chapter beyond its initial chooser window', async () => {
  const stack = await startMediaStack('g-1059-wiki-position', { profileCredits: true });
  try {
    const member = await stack.member('wiki-author');
    for (const [scope, action] of [
      ['work:create:root', 'work.create'],
      ['space:create:root', 'space.create'],
      [`agent:control:${member.actor}`, 'agent.control'],
      [`zone:edit:${wikiZone}`, 'zone.edit'],
      [`zone:official:${wikiZone}`, 'zone.official'],
      [`semantic:read:${wikiZone}`, 'semantic.read'],
    ])
      await member.grant(scope!, action!);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, {
      environment: stack.env,
      access: stack.access,
      content: stack.content,
      contentAuthoring: stack.content,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      structureObjects: objects,
      readingPositions: new ReadingPositionStore(stack.contentPool),
      account: {
        verify: async (request) => {
          if (request.headers.get('authorization') !== `Bearer ${member.token}`)
            throw new AccountAssertionDenied('Unknown bearer');
          return member.principal;
        },
      },
    });
    const collections = new Set<string>();
    const api = new SeedApi({ main: 'http://main.local' } as SeedEndpoints, async (url, init) => {
      // Fixture authority stays in Access; all seed content and replay receipts
      // still go through the exact G999 public command/schema workflow.
      if (init?.method === 'POST' && new URL(url).pathname === '/v1/collections') {
        const { collection } = JSON.parse(String(init.body)) as { collection: string };
        if (!collections.has(collection)) {
          await member.grant(`collection:edit:${collection}`, 'collection.edit');
          await member.grant(`semantic:read:${collection}`, 'semantic.read');
          collections.add(collection);
        }
      }
      if (init?.method === 'POST' && new URL(url).pathname === '/v1/contribution-publications') {
        const { contribution } = JSON.parse(String(init.body)) as { contribution: string };
        await member.grant(`contribution:publish:${contribution}`, 'contribution.publish');
        await member.grant(`contribution:read:${contribution}`, 'contribution.read');
      }
      return app.handle(new Request(url, init));
    });
    const port = {
      api,
      official: api,
      actor: member.actor,
      token: member.token,
      officialToken: member.token,
      prepareWork: async ({ work, mainVersion }: { work: string; mainVersion: string }) => {
        await member.grant(`work:read:${work}`, 'work.read');
        await member.grant(`work:edit:${work}`, 'work.edit');
        await member.grant(`contribution:create:${work}`, 'contribution.create');
        await member.grant(`publication:select:${mainVersion}`, 'publication.select');
      },
    };
    const seeded = await applyOfficialWiki(port);
    await backfillOccurrenceLabels(stack.env);
    // The reported story is retained across seed runs, not a freshly staged
    // composition. Reuse creation receipts and inventory before searching it.
    expect(await applyOfficialWiki(port)).toEqual(seeded);
    expect(await backfillOccurrenceLabels(stack.env)).toMatchObject({ indexed: 0, batches: 0 });
    expect(await occurrenceLabelReadiness(stack.env)).toMatchObject({ status: 'current' });
    const path = `/v1/reading-positions/${short(seeded.work)}`;
    const read = (query: Record<string, string>) =>
      api.getPublic<ReadingPositionPage>(`${path}?${new URLSearchParams(query)}`);
    const first = await read({ limit: '50' });
    expect(first.items).toHaveLength(50);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeString();
    const next = await read({ limit: '50', cursor: first.nextCursor! });
    expect(next.items).toHaveLength(1);
    const occurrence = next.items[0]!.occurrence;
    expect(first.items.some((item) => item.occurrence === occurrence)).toBe(false);
    for (const language of ['en', 'zh-Hant']) {
      const page = await read({
        q: wikiChapterLabels.at(-1)!,
        position: 'all',
        language,
        limit: '50',
      });
      expect(page).toMatchObject({
        complete: true,
        search: { status: 'current' },
        resolved: 'all',
      });
      expect(page.items.map((item) => item.occurrence)).toEqual([occurrence]);
      const choice = positionPickerPage(page, '/wiki?position=all&cursor=old', language, null)
        .items[0]!;
      expect(choice.value).toBe(short(occurrence));
      const params = Object.fromEntries(new URL(choice.href, 'http://web.local').searchParams);
      expect(params).toEqual({ position: short(occurrence) });
      expect((await read({ position: mainPosition(parsePosition(params))! })).resolved).toBe(
        occurrence,
      );
    }
  } finally {
    await stack.stop();
  }
}, 180_000);
