import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { RelationRendering } from '../../../services/main/src/modules/lexicon/render.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';

interface Written { component: string; revision: string }
interface DefinitionKey {
  profile: string;
  key: string;
  kind: 'relation' | 'property';
  definition: string;
  revision: string;
  lifecycle: string;
  roles: { key: string }[];
  editorRecordable: boolean;
  writePath: string | null;
  rendering: RelationRendering;
}
interface Page { items: { key: string }[] }

test('a public count property is readable, with its reviewed name, by an anonymous and a signed-in reader', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `lexicon-property-${randomUUID()}`));
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    // Reviewed names are a platform capability; the definition write itself stays public.
    await grantRecordedPlatformUse(f.accessPool, f.principalId, ['platform-admin']);
    const define = async (notation: string) => f.json<Written>(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'definition', kind: 'property', notation, roles: [] },
    }), 201);
    const defined = await define('episode-count');
    await f.grant(`semantic:edit:${defined.component}`, 'lexicon.presentation.review');
    await f.grant(`semantic:edit:${defined.component}`, 'lexicon.presentation.change');
    const label = (language: string, noun: string, reviewStatus: 'reviewed' | 'draft') => ({
      definition: defined.component, meaningRevision: defined.revision,
      fromRole: 'subject', toRole: 'value', language, noun, heading: noun,
      plurals: { other: noun }, grammaticalForms: [],
      source: 'https://rezics.com/definition/relation-lexicon-seed-v1',
      licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
      reviewStatus,
    });
    const present = async (state: ReturnType<typeof label>) => f.json(await f.call('POST', '/v1/lexicon/presentations', {
      profile: 'definition-presentation-v1', actingSubject: f.actor, expectedHead: null, state,
    }), 201);
    await present(label('en', 'Episodes', 'reviewed'));
    await present(label('ja', '話数', 'reviewed'));
    await present(label('fr', 'Secret draft count', 'draft'));
    const read = (key: string, token: string | null, languages?: string) => {
      const query = new URLSearchParams();
      if (languages) query.set('languages', languages);
      if (token) query.set('actingSubject', f.actor);
      const suffix = query.toString() ? `?${query}` : '';
      return f.call('GET', `/v1/lexicon/definitions/${key}${suffix}`, undefined, randomUUID(), token);
    };
    for (const token of [null, f.account.tokenB]) {
      const response = await read('episode-count', token, 'ja,en');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await f.json<DefinitionKey>(response, 200);
      expect(body).toMatchObject({
        profile: 'relation-definition-key-v1', key: 'episode-count', kind: 'property',
        definition: defined.component, revision: defined.revision, lifecycle: 'active',
        roles: [], editorRecordable: false, writePath: null,
        rendering: { viewingRole: 'subject', projections: [{
          fromRole: 'subject', toRole: 'value', language: 'ja', direction: 'ltr',
          reviewStatus: 'reviewed', fallback: null, labels: { noun: '話数', heading: '話数' },
        }] },
      });
      expect(JSON.stringify(body)).not.toContain('Secret draft count');
    }
    const french = await f.json<DefinitionKey>(await read('episode-count', null, 'fr'), 200);
    expect(['en', 'ja']).toContain(french.rendering.projections[0]!.language);
    expect(['Episodes', '話数']).toContain(french.rendering.projections[0]!.labels?.noun);
    expect(french.rendering.projections[0]).toMatchObject({ reviewStatus: 'reviewed' });
    expect(JSON.stringify(french)).not.toContain('Secret draft count');
    const batch = await f.json<{ items: { status: string; renderings: RelationRendering[] }[] }>(await f.call('GET',
      `/v1/lexicon/presentations?definitions=${encodeURIComponent(defined.component)}&languages=ja`,
      undefined, randomUUID(), null), 200);
    expect(batch.items[0]).toMatchObject({ status: 'available' });
    expect(batch.items[0]!.renderings.find((item) => item.viewingRole === 'subject')?.projections[0])
      .toMatchObject({ language: 'ja', reviewStatus: 'reviewed', labels: { noun: '話数' } });

    const hidden = await define('volume-count');
    await f.accessPool.query('INSERT INTO access.scope_gate (id, open) VALUES ($1, false)',
      [`semantic:read:${hidden.component}`]);
    const missing = await read('missing-key', null);
    const denied = await read('volume-count', null);
    const deniedReader = await read('volume-count', f.account.tokenB);
    expect(missing.status).toBe(404);
    expect(denied.status).toBe(404);
    expect(deniedReader.status).toBe(404);
    const missingBody = await missing.json();
    expect(await denied.json()).toEqual(missingBody);
    expect(await deniedReader.json()).toEqual(missingBody);

    const retired = await define('one-shot-count');
    await f.grant(`semantic:edit:${retired.component}`, 'semantic.change');
    await f.json(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, target: retired.component,
      expectedHead: retired.revision,
      state: { component: 'definition', kind: 'property', notation: 'one-shot-count', roles: [], lifecycle: 'retired' },
    }), 200);
    const gone = await read('one-shot-count', null);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(missingBody);

    await f.json(await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null,
      state: { component: 'definition', kind: 'relation', notation: 'side-story', roles: ['source', 'target'].map((key) => ({
        key, minParticipants: 1, maxParticipants: 1, ordered: false,
      })) },
    }), 201);
    const story = await f.json<DefinitionKey>(await read('side-story', null), 200);
    expect(story.kind).toBe('relation');
    expect(story.roles.map((role) => role.key).sort()).toEqual(['source', 'target']);
    const catalog = await f.json<Page>(await f.call('GET', '/v1/lexicon/definitions?limit=64', undefined, randomUUID(), null), 200);
    expect(catalog.items.map((item) => item.key)).toContain('side-story');
    expect(catalog.items.map((item) => item.key)).not.toContain('episode-count');
  } finally { await f.close(); }
}, 240_000);
