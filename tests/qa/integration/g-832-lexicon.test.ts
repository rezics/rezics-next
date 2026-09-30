import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import {
  renderRelation,
  type RelationRendering,
} from '../../../services/main/src/modules/lexicon/render.ts';
import type { PresentationRead } from '../../../services/main/src/modules/lexicon/change.ts';
import type { PresentationState } from '../../../services/main/src/modules/lexicon/schema.ts';
import { outboxEventHandlers } from '../../../services/main/src/modules/lexicon/outbox-event.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  seedRelationLexicon,
  type SeedLexiconReceipt,
} from '../../../scripts/dev/seed/relation-lexicon.ts';
import { uiLocales } from '../../../apps/web/i18n/define.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';

type Write = SeedLexiconReceipt & {
  receipt: string;
  replayed: boolean;
  predecessor: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
};
type Batch = { items: { definition: string; status: string; renderings: RelationRendering[] }[] };
const roles = ['source', 'target'].map((key) => ({
  key,
  minParticipants: 1,
  maxParticipants: 64,
  ordered: false,
}));

test('G-832: public lexicon revisions, denied writes, retries, concurrency, exact meanings and fallback provenance', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `g-832-${randomUUID()}`),
  );
  try {
    const commands: { bytes: number; focuses: number }[] = [];
    const languageQueries: string[] = [];
    let loseResponse = false;
    f.env.fuseki = new Proxy(f.env.fuseki, {
      get(target, property) {
        if (property === 'commandWithReceipt')
          return async (envelope: CommandEnvelope) => {
            const presentation = envelope.update.includes('LexiconPresentationChangedEvent');
            if (presentation)
              commands.push({
                bytes: Buffer.byteLength(JSON.stringify(envelope)),
                focuses: envelope.validations.reduce(
                  (count, entry) => count + entry.focus.length,
                  0,
                ),
              });
            const result = await target.commandWithReceipt(envelope);
            if (presentation && loseResponse) {
              loseResponse = false;
              throw new Error('lost lexicon acknowledgement');
            }
            return result;
          };
        if (property === 'query')
          return async (query: string) => {
            if (query.includes('SELECT ?presentation ?head ?language')) languageQueries.push(query);
            return target.query(query);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await f.grant('semantic:create:root', 'semantic.change');
    const definition = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        actingSubject: f.actor,
        expectedHead: null,
        state: { component: 'definition', kind: 'relation', roles },
      }),
      201,
    );
    await f.grant(`semantic:read:${definition.component}`, 'semantic.read');
    const label = (
      language: string,
      fromRole = 'source',
      toRole = 'target',
    ): PresentationState => ({
      definition: definition.component,
      meaningRevision: definition.revision,
      fromRole,
      toRole,
      language,
      noun: language === 'ar' ? 'اقتباس' : 'Adaption',
      heading: language === 'ar' ? 'اقتباسات' : 'Adaptionen',
      plurals: { other: language === 'ar' ? 'اقتباسات' : 'Adaptionen' },
      grammaticalForms: [{ case: 'dative', number: 'plural', value: 'Adaptionen' }],
      source: 'https://example.com/vocabulary',
      licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
      reviewStatus: 'draft',
    });
    const change = (
      state: PresentationState,
      key = randomUUID(),
      target?: string,
      expectedHead: string | null = null,
      token?: string,
    ) =>
      f.call(
        'POST',
        '/v1/lexicon/presentations',
        {
          profile: 'definition-presentation-v1',
          actingSubject: f.actor,
          state,
          expectedHead,
          ...(target ? { target } : {}),
        },
        key,
        token,
      );
    const batch = (
      languages = 'de',
      definitions = [definition.component],
      revisions?: string[],
      token?: string,
    ) =>
      f.call(
        'GET',
        `/v1/lexicon/presentations?${new URLSearchParams({
          actingSubject: f.actor,
          definitions: definitions.join(','),
          languages,
          ...(revisions ? { revisions: revisions.join(',') } : {}),
        })}`,
        undefined,
        randomUUID(),
        token,
      );
    await f.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`semantic:edit:${definition.component}`],
    );
    expect(
      (await change(label('de'), randomUUID(), undefined, null, f.account.noScope)).status,
    ).toBe(401);
    expect((await change(label('de'))).status).toBe(403);
    let grant = await f.grant(
      `semantic:edit:${definition.component}`,
      'lexicon.presentation.change',
    );
    const key = `presentation-${randomUUID()}`;
    const de = await f.json<Write>(await change(label('de'), key), 201);
    expect(await f.json<Write>(await change(label('de'), key), 201)).toMatchObject({
      component: de.component,
      revision: de.revision,
      receipt: de.receipt,
      replayed: true,
    });
    expect((await change({ ...label('de'), noun: 'Bearbeitung' }, key)).status).toBe(409);
    expect((await change(label('de'))).status).toBe(409); // the language/direction slot has one identity
    for (const language of ['de', 'ar'])
      for (const [from, to] of [
        ['source', 'target'],
        ['target', 'source'],
      ]) {
        if (language !== 'de' || from !== 'source')
          await f.json(await change(label(language, from, to)), 201);
      }
    for (const language of ['de', 'ar']) {
      const current = await f.json<Batch>(await batch(language), 200);
      expect(current.items[0]!.renderings).toHaveLength(2);
      for (const rendering of current.items[0]!.renderings)
        expect(rendering.projections[0]).toMatchObject({
          language,
          direction: language === 'ar' ? 'rtl' : 'ltr',
          reviewStatus: 'draft',
          fallback: null,
        });
    }
    const edit = { ...label('de'), noun: 'Bearbeitung', reviewStatus: 'reviewed' as const };
    expect((await change(edit, randomUUID(), de.component, de.revision)).status).toBe(403);
    expect((await change({ ...label('ja'), reviewStatus: 'reviewed' })).status).toBe(403);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      grant,
    ]);
    const reviewer = await f.grant(
      `semantic:edit:${definition.component}`,
      'lexicon.presentation.review',
    );
    const updated = await f.json<Write>(
      await change(edit, randomUUID(), de.component, de.revision),
      200,
    );
    expect(updated).toMatchObject({ component: de.component, predecessor: de.revision });
    expect((await change(edit, randomUUID(), de.component, de.revision)).status).toBe(409);
    const currentMeaning = await f.json<{ revision: string }>(
      await f.call(
        'GET',
        `/v1/semantic/resources/${shortId(definition.component)}?actingSubject=${encodeURIComponent(f.actor)}`,
      ),
      200,
    );
    expect(currentMeaning.revision).toBe(definition.revision);
    const currentLabel = await f.json<PresentationRead>(
      await f.call(
        'GET',
        `/v1/lexicon/presentations/${shortId(de.component)}?actingSubject=${encodeURIComponent(f.actor)}`,
      ),
      200,
    );
    expect(currentLabel.state).toEqual(edit);
    const historical = await f.json<PresentationRead>(
      await f.call(
        'GET',
        `/v1/lexicon/presentations/${shortId(de.component)}/revisions/${shortId(de.revision)}?actingSubject=${encodeURIComponent(f.actor)}`,
      ),
      200,
    );
    expect(historical.state.noun).toBe('Adaption');

    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      reviewer,
    ]);
    grant = await f.grant(`semantic:edit:${definition.component}`, 'lexicon.presentation.change');
    expect(
      (
        await change(
          { ...edit, noun: 'Unreviewed wording' },
          randomUUID(),
          de.component,
          updated.revision,
        )
      ).status,
    ).toBe(403);
    const draft = { ...edit, reviewStatus: 'draft' as const };
    const drafted = await f.json<Write>(
      await change(draft, randomUUID(), de.component, updated.revision),
      200,
    );

    const concurrent = await Promise.all([
      change({ ...draft, noun: 'Fassung A' }, randomUUID(), de.component, drafted.revision),
      change({ ...draft, noun: 'Fassung B' }, randomUUID(), de.component, drafted.revision),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      grant,
    ]);
    expect((await change(label('ja'))).status).toBe(403);
    await f.grant(`semantic:edit:${definition.component}`, 'lexicon.presentation.change');

    // More than twenty languages remain selectable; tags outside the UI locales need no deployment.
    const languages = [
      'en',
      'fr',
      'es',
      'ja',
      'ko',
      'it',
      'pt',
      'nl',
      'sv',
      'da',
      'no',
      'fi',
      'pl',
      'cs',
      'sk',
      'hu',
      'ro',
      'bg',
      'el',
      'tr',
      'uk',
      'vi',
      'id',
      'th',
      'sr-Latn',
      'zh-Hant',
      'az-Arab',
    ];
    for (const language of languages) await f.json(await change(label(language)), 201);
    loseResponse = true;
    const recoveryKey = `lost-${randomUUID()}`;
    const recovered = await f.json<Write>(await change(label('fa'), recoveryKey), 201);
    expect(await f.json<Write>(await change(label('fa'), recoveryKey), 201)).toMatchObject({
      component: recovered.component,
      revision: recovered.revision,
      receipt: recovered.receipt,
      replayed: true,
    });
    expect(
      (await f.json<Batch>(await batch('th'), 200)).items[0]!.renderings[0]!.projections[0]!
        .language,
    ).toBe('th');
    const hant = (await f.json<Batch>(await batch('zh-Hant-TW'), 200)).items[0]!.renderings[0]!
      .projections[0]!;
    expect(hant).toMatchObject({
      language: 'zh-Hant',
      script: 'Hant',
      fallback: { crossedScript: false },
    });
    const latin = (await f.json<Batch>(await batch('sr-Latn'), 200)).items[0]!.renderings[0]!
      .projections[0]!;
    expect(latin).toMatchObject({ language: 'sr-Latn', script: 'Latn', fallback: null });
    expect(
      (await f.json<Batch>(await batch('az-Arab'), 200)).items[0]!.renderings[0]!.projections[0]!
        .script,
    ).toBe('Arab');
    expect(
      (
        await batch(
          'de',
          Array.from({ length: 65 }, () => definition.component),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.json<Batch>(
          await batch('de', [definition.component], undefined, f.account.tokenB),
          200,
        )
      ).items[0],
    ).toMatchObject({ status: 'unavailable', renderings: [] });

    // An occurrence keeps one fact with both roles; redaction happens before typed rendering arguments.
    await f.grant('relation:create:root', 'relation.change');
    const occurrence = await f.json<{ occurrence: string; revision: string }>(
      await f.call('POST', '/v1/relations/changes', {
        profile: 'relation-change-v1',
        actingSubject: f.actor,
        expectedHead: null,
        definition: definition.revision,
        participations: [
          { role: 'source', participant: { kind: 'resource', ref: definition.component } },
          {
            role: 'target',
            participant: { kind: 'external', provider: 'example', namespace: 'work', key: 'one' },
          },
        ],
      }),
      201,
    );
    await f.grant(`semantic:read:${occurrence.occurrence}`, 'semantic.read');
    await f.grant(`semantic:edit:${definition.component}`, 'semantic.change');
    const newMeaning = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        actingSubject: f.actor,
        target: definition.component,
        expectedHead: definition.revision,
        state: {
          component: 'definition',
          kind: 'relation',
          roles: roles.map((role) => ({ ...role, maxParticipants: 32 })),
        },
      }),
      200,
    );
    const incompatible = await f.json<Batch>(await batch('de'), 200);
    for (const rendering of incompatible.items[0]!.renderings)
      expect(rendering).toMatchObject({
        meaning: { revision: newMeaning.revision },
        projections: [{ labels: null, fallback: { reason: 'missing-direction' } }],
      });
    expect((await change(label('ja'))).status).toBe(422);
    // Fresh compatible wording coexists with the old meaning's labels for historical occurrences.
    const compatible = {
      ...label('de'),
      meaningRevision: newMeaning.revision,
      noun: 'Neue Bedeutung',
    };
    const newPresentation = await f.json<Write>(await change(compatible), 201);
    expect(newPresentation.component).not.toBe(de.component);
    expect(
      (await f.json<Batch>(await batch('de'), 200)).items[0]!.renderings[0]!.projections[0]!.labels
        ?.noun,
    ).toBe('Neue Bedeutung');
    expect((await change(compatible, randomUUID(), de.component, updated.revision)).status).toBe(
      400,
    );
    const pinned = await renderRelation(
      f.env,
      { occurrence: occurrence.occurrence },
      'source',
      ['de'],
      async (ref) => ref === occurrence.occurrence,
    );
    expect(pinned.meaning.revision).toBe(definition.revision);
    expect(pinned.projections[0]!.labels?.noun).toMatch(/^Fassung [AB]$/);
    expect(pinned.bindings[0]!.participant).toEqual({ kind: 'unavailable-reference' });
    expect(JSON.stringify(pinned.projections[0]!.arguments)).not.toContain(definition.component);
    const revisionManifest = (
      await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(historical.revision)} rv:manifest ?manifest } }`)
    ).results!.bindings[0]!.manifest!.value;
    const file = join(f.env.objectDirectory, revisionManifest.slice(-64));
    expect(readFileSync(file).length).toBeGreaterThan(0);
    renameSync(file, `${file}.held`);
    try {
      expect(
        (
          await f.call(
            'GET',
            `/v1/lexicon/presentations/${shortId(de.component)}/revisions/${shortId(de.revision)}?actingSubject=${encodeURIComponent(f.actor)}`,
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await f.call(
            'GET',
            `/v1/lexicon/presentations/${shortId(de.component)}/revisions/${shortId(de.revision)}?actingSubject=${encodeURIComponent(f.actor)}`,
            undefined,
            randomUUID(),
            f.account.tokenB,
          )
        ).status,
      ).toBe(404);
    } finally {
      renameSync(`${file}.held`, file);
    }

    for (const [written, action] of [
      [de, 'lexicon.presentation.change'],
      [updated, 'lexicon.presentation.review'],
    ] as const) {
      const receiptRows = await f.env.fuseki
        .query(`PREFIX rv: <${RV}> SELECT ?admission ?epoch ?scope ?digest WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(written.receipt)} rv:admissionId ?admission ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:requestDigest ?digest } }`);
      const receiptRow = receiptRows.results!.bindings[0]!;
      const eventRow = (
        await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?event ?batch WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ?event a rv:LexiconPresentationChangedEvent ; rv:receipt ${iri(written.receipt)} .
        ?batch rv:event ?event } }`)
      ).results!.bindings[0]!;
      const values: Record<string, string> = {
        action,
        receipt: written.receipt,
        ...(written.predecessor ? { expectedHead: written.predecessor } : {}),
        admissionId: receiptRow.admission!.value,
        authorityEpoch: receiptRow.epoch!.value,
        scope: receiptRow.scope!.value,
        digest: receiptRow.digest!.value,
        outcome: `${RV}Succeeded`,
        epoch: written.sourcePosition.dataEpoch,
        sequence: written.sourcePosition.sequence,
      };
      const event = await outboxEventHandlers[0]!.read({
        fuseki: f.env.fuseki,
        eventId: eventRow.event!.value,
        batch: {
          batchId: eventRow.batch!.value,
          dataEpoch: written.sourcePosition.dataEpoch,
          sequence: written.sourcePosition.sequence,
          routingEpoch: f.env.lineage.routingEpoch,
          eventIds: [eventRow.event!.value],
        },
        ordinal: 0,
        value: (name) => values[name],
      });
      expect(event.data.receipt).toMatchObject({
        action,
        component: written.component,
        revision: written.revision,
        meaningRevision: definition.revision,
      });
    }
    expect(commands.every((command) => command.focuses === 2 && command.bytes < 131_072)).toBe(
      true,
    );
    expect(languageQueries.length).toBeGreaterThan(0);
    expect(
      languageQueries.every(
        (query) =>
          query.includes('rv:meaningRevision <https://rezics.com/id/') && !query.includes('LIMIT'),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 180_000);

test('G-832: public bootstrap and class guard cover every definition, direction and UI locale', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    // Definitions are canonical across files in this QA shard; their immutable
    // bytes must be available when a later fixture reads the same registry.
    resolve('.temp', 'relation-lexicon-qa', Bun.env.REZICS_QA_RUN_ID),
  );
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const shared = await Promise.all(relationLexiconSeed.map(item => readDefinitionByKey(f.env, item.key)));
    const data = shared.every(item => item !== null) ? shared.map((item, index) => ({
      key: relationLexiconSeed[index]!.key, component: item!.definition, revision: item!.revision,
    })) : await seedRelationLexicon(
      {
        post: async <T>(path: string, body: object, key: string) =>
          f.json<T>(await f.call('POST', path, body, key), 201),
        authorizeDefinition: async (receipt) => {
          await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
          await f.grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
        },
      },
      f.actor,
      `g-832-${randomUUID()}`,
    );
    if (shared.every(item => item !== null)) {
      for (const receipt of data) await f.grant(`semantic:read:${receipt.component}`, 'semantic.read');
    }
    expect(data).toHaveLength(15);
    for (const language of uiLocales) {
      const batch = await f.json<Batch>(
        await f.call(
          'GET',
          `/v1/lexicon/presentations?${new URLSearchParams({
            actingSubject: f.actor,
            definitions: data.map((item) => item.component).join(','),
            languages: language,
          })}`,
        ),
        200,
      );
      expect(batch.items).toHaveLength(data.length);
      for (const item of batch.items) {
        expect(item.status).toBe('available');
        expect(item.renderings).toHaveLength(2);
        for (const rendering of item.renderings)
          for (const projection of rendering.projections) {
            expect(projection.labels !== null || projection.fallback !== null).toBe(true);
            expect(
              projection.fallback?.crossedScript
                ? projection.fallback.reason === 'script-fallback'
                : true,
            ).toBe(true);
            expect(projection.language).toBe(language);
            expect(projection.reviewStatus).toBe('draft');
            expect(projection.labels?.plurals.other).toBeTruthy();
          }
      }
    }
    // An absent inverse returns its own explicit absence, never an invented inverse phrase.
    const definition = await f.json<Write>(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        actingSubject: f.actor,
        expectedHead: null,
        state: { component: 'definition', kind: 'relation', roles },
      }),
      201,
    );
    await f.grant(`semantic:read:${definition.component}`, 'semantic.read');
    const absent = await renderRelation(
      f.env,
      { definition: definition.component },
      'target',
      ['de'],
      async () => true,
    );
    expect(absent.projections[0]).toMatchObject({
      labels: null,
      fallback: { reason: 'missing-direction' },
    });
  } finally {
    await f.close();
  }
}, 180_000);
