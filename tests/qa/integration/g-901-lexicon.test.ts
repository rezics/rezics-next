import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import {
  seedRelationLexicon,
  type SeedLexiconReceipt,
} from '../../../scripts/dev/seed/relation-lexicon.ts';
import type { RelationRendering } from '../../../services/main/src/modules/lexicon/render.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { DefinitionState } from '../../../services/main/src/modules/semantic/change.ts';

interface Item {
  key: string;
  definition: string;
  revision: string;
  lifecycle: string;
  editorRecordable: boolean;
  writePath: 'derivation' | 'relation' | null;
  workSubjectRole: string | null;
  roles: RelationRendering['meaning']['roles'];
  rendering: RelationRendering;
}
interface Page {
  profile: 'relation-definition-list-v1';
  items: Item[];
  next: string | null;
}

test('G-901: public editor catalog discovers seeded and newly admitted choices, pages and fences private or retired meanings', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `g-901-${randomUUID()}`),
  );
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const choices = relationLexiconSeed.filter(
      (item) => 'editorRecordable' in item && item.editorRecordable,
    );
    const seeded = await seedRelationLexicon(
      {
        post: async <T>(path: string, body: object, key: string) => {
          // Public discovery uses the established reviewed rendering path; drafts remain private.
          const admitted =
            path === '/v1/lexicon/presentations'
              ? {
                  ...body,
                  state: { ...(body as { state: object }).state, reviewStatus: 'reviewed' },
                }
              : body;
          return f.json<T>(await f.call('POST', path, admitted, key), 201);
        },
        authorizeDefinition: async (receipt) => {
          await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
          await f.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.review');
        },
      },
      f.actor,
      `g901-${randomUUID()}`,
      choices.map((item) => ({
        ...item,
        labels: item.labels.filter((label) => label[0] === 'en'),
      })),
    );

    const app = createMainApp(f.env.fuseki, {
      environment: f.env,
      access: f.access,
      account: f.account.verifier,
    });
    const publicCall = (query: string, token?: string) =>
      app.handle(
        new Request(`http://main.local/v1/lexicon/definitions?${query}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );
    const page = async (query = 'recordable=true&languages=en', token?: string) =>
      f.json<Page>(await publicCall(query, token), 200);
    const first = await page();
    expect(first.profile).toBe('relation-definition-list-v1');
    expect(first.next).toBeNull();
    expect(Object.fromEntries(first.items.map((item) => [item.key, item.writePath]))).toEqual(
      Object.fromEntries(
        choices.map((item) => [item.key, 'writePath' in item ? item.writePath : null]),
      ),
    );
    for (const item of first.items) {
      expect(item.editorRecordable).toBe(true);
      expect(item.roles).toHaveLength(2);
      expect(
        item.roles.every(
          (role) => role.minParticipants === 1 && role.maxParticipants === 1 && !role.ordered,
        ),
      ).toBe(true);
      expect(item.rendering.viewingRole).toBe(item.workSubjectRole!);
      expect(item.rendering.projections[0]).toMatchObject({
        language: 'en',
        reviewStatus: 'reviewed',
        fallback: null,
      });
      expect(item.rendering.projections[0]!.labels?.noun).toBeTruthy();
    }
    const roles = [
      { key: 'source', minParticipants: 1, maxParticipants: 3, ordered: true },
      { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
    ];
    const create = async (notation: string, recording: object = {}) => {
      const state = {
        component: 'definition',
        kind: 'relation',
        notation,
        workSubjectRole: 'target',
        roles,
        ...recording,
      };
      const receipt = await f.json<SeedLexiconReceipt>(
        await f.call('POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          actingSubject: f.actor,
          expectedHead: null,
          state,
        }),
        201,
      );
      return { state, receipt };
    };
    const future = await create('future-editor-kind', {
      editorRecordable: true,
      writePath: 'relation',
    });
    const legacy = await create('future-unrecordable-kind');
    const discovered = (await page()).items.find((item) => item.key === 'future-editor-kind')!;
    expect(discovered).toMatchObject({
      definition: future.receipt.component,
      revision: future.receipt.revision,
      writePath: 'relation',
      roles: [
        { key: 'source', minParticipants: 1, maxParticipants: 3, ordered: true },
        { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false },
      ],
    });
    expect(discovered.rendering.projections[0]).toMatchObject({
      labels: null,
      fallback: { reason: 'missing-direction' },
    });
    expect(
      (await page('recordable=false&languages=en')).items.map((item) => item.definition),
    ).toEqual([legacy.receipt.component]);
    expect((await page('languages=en')).items).toHaveLength(10);

    // Close an exact read gate, then remove its object. Neither anonymous discovery nor an editor token loads/leaks it.
    await f.grant(`semantic:read:${future.receipt.component}`, 'semantic.read');
    await f.access.strongCloseScope(`semantic:read:${future.receipt.component}`, '0');
    const manifest = (
      await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(future.receipt.revision)} rv:manifest ?manifest } }`)
    ).results!.bindings[0]!.manifest!.value;
    const object = join(f.env.objectDirectory, manifest.slice(-64));
    expect(readFileSync(object).length).toBeGreaterThan(0);
    renameSync(object, `${object}.held`);
    try {
      for (const token of [undefined, f.account.tokenA]) {
        expect(
          (await page(undefined, token)).items.some(
            (item) => item.definition === future.receipt.component,
          ),
        ).toBe(false);
      }
    } finally {
      renameSync(`${object}.held`, object);
    }

    const retired = seeded.find((item) => item.key === 'sequel')!;
    const spec = choices.find((item) => item.key === 'sequel')!;
    await f.grant(`semantic:edit:${retired.component}`, 'semantic.change');
    await f.json(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        actingSubject: f.actor,
        target: retired.component,
        expectedHead: retired.revision,
        state: {
          component: 'definition',
          kind: 'relation',
          lifecycle: 'retired',
          notation: spec.key,
          editorRecordable: true,
          writePath: 'relation',
          workSubjectRole: spec.roles[1],
          roles: spec.roles.map((key) => ({
            key,
            minParticipants: 1,
            maxParticipants: 1,
            ordered: false,
          })),
        },
      }),
      200,
    );
    const keys: string[] = [];
    let cursor: string | null = null,
      pages = 0;
    do {
      const query = new URLSearchParams({
        recordable: 'true',
        languages: 'en',
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      const result = await page(query.toString());
      expect(result.items.length).toBeLessThanOrEqual(1);
      keys.push(...result.items.map((item) => item.key));
      cursor = result.next;
      if (++pages > 16) throw new Error('catalog continuation did not progress');
    } while (cursor);
    expect(keys).toEqual(first.items.map((item) => item.key).filter((key) => key !== 'sequel'));
    expect(new Set(keys).size).toBe(keys.length);
    expect((await publicCall('recordable=invalid')).status).toBe(400);
    expect((await publicCall('recordable=true&limit=65')).status).toBe(400);
    expect((await publicCall('cursor=invalid')).status).toBe(400);
    const continuation = (await page('recordable=true&languages=en&limit=1')).next!;
    expect(
      (
        await publicCall(
          new URLSearchParams({
            recordable: 'false',
            languages: 'en',
            limit: '1',
            cursor: continuation,
          }).toString(),
        )
      ).status,
    ).toBe(400);
    await seedRelationLexicon(
      {
        currentDefinition: async () => {
          const current = await f.json<{ revision: string; state: DefinitionState }>(
            await f.call(
              'GET',
              `/v1/semantic/resources/${legacy.receipt.component.split('/').at(-1)}?actingSubject=${encodeURIComponent(f.actor)}`,
            ),
            200,
          );
          return { component: legacy.receipt.component, ...current };
        },
        authorizeDefinition: async (receipt) => {
          await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
          await f.grant(`semantic:edit:${receipt.component}`, 'semantic.change');
        },
        post: async <T>(path: string, body: object, key: string) =>
          f.json<T>(await f.call('POST', path, body, key), 200),
      },
      f.actor,
      `upgrade-${randomUUID()}`,
      [
        {
          key: legacy.state.notation,
          roles: ['source', 'target'],
          labels: [],
          editorRecordable: true,
          writePath: 'relation',
        },
      ],
    );
    const upgraded = (await page()).items.find(
      (item) => item.definition === legacy.receipt.component,
    )!;
    expect(upgraded).toMatchObject({
      key: legacy.state.notation,
      editorRecordable: true,
      writePath: 'relation',
      roles: [{ key: 'source', maxParticipants: 3, ordered: true }, { key: 'target' }],
    });
    expect(upgraded.revision).not.toBe(legacy.receipt.revision);
  } finally {
    await f.close();
  }
}, 180_000);
