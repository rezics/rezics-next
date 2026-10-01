import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  entityPage,
  subjectStatementPage,
} from '../../../services/main/src/modules/entity-page/contract.ts';
import { GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../../../services/main/src/modules/classification/context.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import {
  decisionSlotIri,
  statementMeaningKey,
} from '../../../services/main/src/modules/statement/schema.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

type Work = { work: string; workRevision: string; mainVersion: string };
type Change = {
  component: string;
  revision: string;
  receipt: string;
  predecessor: string | null;
  replayed: boolean;
};
type Page = Static<typeof entityPage>;
type Statements = Static<typeof subjectStatementPage>;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

test('G-629: SAO, VideoGame and unknown resource pages; component CAS, identity preservation and complete statement traversal', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = resolve('.temp', `g-629-${randomUUID()}`);
  const started = Date.now();
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read work:protect statement:write statement:decide context:read',
  );
  try {
    await f.grant('catalogue:verify:root', 'catalogue.verify');
    const createWork = async (title: string, type = 'https://schema.org/Book') => {
      const created = await f.json<Work>(
        await f.call('POST', '/v1/works', await f.catalogueBody({
          profile: 'metadata-only-v1',
          language: 'en',
          title,
          semanticTypes: [type],
          actingSubject: f.actor,
        })),
        201,
      );
      await f.grant(`work:read:${created.work}`, 'work.read');
      return created;
    };
    const read = (resource: string, path = 'page', suffix = '', token = f.account.tokenA) =>
      f.call(
        'GET',
        `/v1/resources/${shortId(resource)}/${path}?actingSubject=${encodeURIComponent(f.actor)}${suffix}`,
        undefined,
        randomUUID(),
        token,
      );
    const change = (
      resource: string,
      expectedHead: string,
      properties: object[],
      key = randomUUID(),
    ) =>
      f.call(
        'POST',
        '/v1/semantic/changes',
        {
          profile: 'semantic-change-v1',
          target: resource,
          expectedHead,
          state: {
            component: 'resource',
            types: [],
            properties,
          },
          actingSubject: f.actor,
        },
        key,
      );
    const sao = {
      web: await createWork('Sword Art Online'),
      bunko: await createWork('Sword Art Online'),
      volume1: await createWork('Sword Art Online volume 1'),
    };
    const game = await createWork('SAO Hollow Realization', 'https://schema.org/VideoGame');
    const recipe = await createWork('Ragout rabbit recipe', 'https://schema.org/Recipe');
    const prompt = await createWork('Aincrad character prompt', `${RV}PromptTemplate`);
    const skill = await createWork('SAO indexing skill', `${RV}SkillPackage`);
    for (const work of [...Object.values(sao), game, recipe, prompt, skill]) {
      const page = await f.json<Page>(await read(work.work), 200);
      expect(Value.Check(entityPage, page)).toBe(true);
      expect(page.target).toMatchObject({ resource: work.work, base: 'work', work: work.work });
      expect(page.work?.id).toBe(work.work);
      expect(page.sections.map((section) => section.id)).toEqual([
        'statements',
        ...(work === recipe
          ? ['recipe']
          : work === prompt
            ? ['prompt']
            : work === skill
              ? ['skill']
              : []),
        'releases',
        'contents',
        'relations',
        'credits',
        'ratings',
        'reviews',
        'discussion',
      ]);
      expect(
        page.sections.every(
          (section) => section.count === undefined && section.actions.length === 0,
        ),
      ).toBe(true);
      expect((await read(work.work, 'page', '', f.account.tokenB)).status).toBe(404);
    }
    await f.grant(`work:edit:${sao.bunko.work}`, 'work.edit');
    const editor = await f.json<Page>(await read(sao.bunko.work), 200);
    expect(
      editor.sections.filter((section) => section.actions.length).map((section) => section.id),
    ).toEqual(['releases', 'contents']);
    expect((await read(sao.bunko.work, 'page', '&unknown=1')).status).toBe(400);

    await f.grant('semantic:create:root', 'semantic.change');
    expect(
      (
        await f.call('POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          expectedHead: null,
          state: { component: 'resource', types: [], properties: [] },
          actingSubject: f.actor,
        })
      ).status,
    ).toBe(400);
    const unknown = await f.json<Change>(
      await f.call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        state: {
          component: 'resource',
          types: ['https://example.org/UnregisteredType'],
          properties: [
            {
              predicate: 'https://schema.org/name',
              value: { kind: 'language-string', lexical: 'بذرة مجهولة', language: 'ar' },
            },
          ],
        },
        actingSubject: f.actor,
      }),
      201,
    );
    const unknownGrant = await f.grant(`semantic:read:${unknown.component}`, 'semantic.read');
    const unknownPage = await f.json<Page>(await read(unknown.component), 200);
    expect(Value.Check(entityPage, unknownPage)).toBe(true);
    expect(unknownPage.target).toMatchObject({ base: 'resource', work: null });
    expect(unknownPage.registry).toMatchObject({ default: true, presentation: 'default' });
    expect(unknownPage.work).toBeNull();
    expect(unknownPage.sections.map((section) => section.id)).toEqual(['statements', 'relations', 'discussion']);
    await f.grant(`semantic:edit:${unknown.component}`, 'semantic.change');
    expect((await change(unknown.component, unknown.revision, [])).status).toBe(400);

    // Attaching the first description is a CAS against the existing Work head;
    // subsequent changes compare the independent semantic head.
    await f.grant(`semantic:edit:${sao.bunko.work}`, 'semantic.change');
    const workOwned = [
      ...[
        'head',
        'mainVersion',
        'continuityProfile',
        'scalarValue',
        'release',
        'protectionHead',
        'titleControlHead',
        'descriptiveMetadataHead',
        'completionStatus',
      ].map((local) => `${RV}${local}`),
      'http://www.w3.org/2000/01/rdf-schema#label',
      ...['alternateName', 'description', 'isPartOf'].map((local) => `https://schema.org/${local}`),
    ];
    const rejectWorkFields = async (head: string) => {
      for (const predicate of workOwned) {
        const response = await change(sao.bunko.work, head, [
          { predicate, value: { kind: 'string', lexical: 'Forged owner field' } },
        ]);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'reserved_owner' });
      }
    };
    await rejectWorkFields(sao.bunko.workRevision);
    const staleKey = randomUUID();
    expect((await change(sao.bunko.work, nativeId(), [], staleKey)).status).toBe(409);
    const properties = [
      {
        predicate: 'https://example.org/originalPublication',
        value: { kind: 'integer', lexical: '2009' },
      },
    ];
    const key = randomUUID();
    const attached = await f.json<Change>(
      await change(sao.bunko.work, sao.bunko.workRevision, properties, key),
      200,
    );
    expect(attached).toMatchObject({
      component: sao.bunko.work,
      predecessor: null,
      replayed: false,
    });
    expect(attached.receipt).toBeTruthy();
    expect(
      await f.json<Change>(
        await change(sao.bunko.work, sao.bunko.workRevision, properties, key),
        200,
      ),
    ).toMatchObject({ revision: attached.revision, receipt: attached.receipt, replayed: true });
    expect((await change(sao.bunko.work, sao.bunko.workRevision, [])).status).toBe(409);
    const after = await f.json<Page>(await read(sao.bunko.work), 200);
    expect(after.target.resource).toBe(editor.target.resource);
    expect(after.work?.title).toEqual(editor.work?.title);
    expect(after.work?.revision).toBe(editor.work?.revision);
    expect(after.registry.type).toBe('https://schema.org/Book');
    const description = await f.json<Statements>(await read(sao.bunko.work, 'statements'), 200);
    expect(description.groups[0]?.items[0]).toMatchObject({
      kind: 'component-property',
      revision: attached.revision,
      value: { kind: 'integer', lexical: '2009' },
    });
    const edited = await f.json<Change>(
      await change(sao.bunko.work, attached.revision, [
        { ...properties[0], value: { kind: 'integer', lexical: '2008' } },
      ]),
      200,
    );
    expect(edited.predecessor).toBe(attached.revision);
    await rejectWorkFields(edited.revision);
    const refused = await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1',
      target: sao.bunko.work,
      expectedHead: edited.revision,
      state: { component: 'resource', types: ['https://schema.org/CreativeWork'], properties: [] },
      actingSubject: f.actor,
    });
    expect(refused.status).toBe(422);
    const overlap = await f.call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1',
      target: sao.bunko.work,
      expectedHead: edited.revision,
      state: { component: 'resource', types: ['https://schema.org/Book'], properties: [] },
      actingSubject: f.actor,
    });
    expect(overlap.status).toBe(422);

    await f.grant(`semantic:edit:${sao.volume1.work}`, 'semantic.change');
    const concurrent = await Promise.all([
      change(sao.volume1.work, sao.volume1.workRevision, properties),
      change(sao.volume1.work, sao.volume1.workRevision, [
        { ...properties[0], value: { kind: 'integer', lexical: '2010' } },
      ]),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const concurrentWinner = await f.json<Change>(
      concurrent.find((response) => response.status === 200)!,
      200,
    );
    // A lost graph acknowledgement still resolves the committed receipt.
    await f.grant(`semantic:edit:${sao.web.work}`, 'semantic.change');
    const originalGraph = f.env.fuseki;
    let lost = false;
    let recoveredHead = '';
    f.env.fuseki = new Proxy(originalGraph, {
      get(target, property) {
        if (property === 'commandWithReceipt')
          return async (envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
            const result = await target.commandWithReceipt(envelope);
            if (!lost && envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor')) {
              lost = true;
              throw new Error('Lost semantic graph acknowledgement');
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const recovered = await f.json<Change>(
        await change(sao.web.work, sao.web.workRevision, properties),
        200,
      );
      expect(recovered.component).toBe(sao.web.work);
      expect(recovered.receipt).toBeTruthy();
      expect(lost).toBe(true);
      recoveredHead = recovered.revision;
    } finally {
      f.env.fuseki = originalGraph;
    }

    // Unlisted predicates already present on a shared subject are also owned.
    await f.grant(`semantic:edit:${game.work}`, 'semantic.change');
    const otherPredicate = 'https://example.org/otherComponent';
    const externalField = `${iri(game.work)} <${otherPredicate}> "Other owner" .`;
    await f.nativeFuseki.update(
      `INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${externalField} } }`,
    );
    const overlappingProperty = [
      { predicate: otherPredicate, value: { kind: 'string', lexical: 'Overwrite' } },
    ];
    expect((await change(game.work, game.workRevision, overlappingProperty)).status).toBe(422);
    await f.nativeFuseki.update(
      `DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${externalField} } }`,
    );
    let overlapRace = false;
    f.env.fuseki = new Proxy(originalGraph, {
      get(target, property) {
        if (property === 'commandWithReceipt')
          return async (envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
            if (
              !overlapRace &&
              envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor')
            ) {
              overlapRace = true;
              await f.nativeFuseki.update(
                `INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${externalField} } }`,
              );
            }
            return target.commandWithReceipt(envelope);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect((await change(game.work, game.workRevision, overlappingProperty)).status).toBe(422);
      expect(overlapRace).toBe(true);
    } finally {
      f.env.fuseki = originalGraph;
    }
    expect(
      (await f.nativeFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} { ${externalField} } }`))
        .boolean,
    ).toBe(true);
    await f.nativeFuseki.update(
      `DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${externalField} } }`,
    );

    const protect = async (work: Work) => {
      await f.grant(`work:protect:${work.work}`, 'work.protection.tighten');
      const basis = await f.json<{
        contentHead: string;
        protectionHead: string | null;
        controlHead: string | null;
        controlEpoch: string;
        ruleRevision: string;
      }>(
        await f.call(
          'GET',
          `/v1/works/${shortId(work.work)}/editorial-state?actingSubject=${encodeURIComponent(f.actor)}`,
        ),
        200,
      );
      await f.json(
        await f.call('POST', '/v1/work-title-protections', {
          profile: 'work-title-protection-v1',
          action: 'tighten',
          work: work.work,
          expectedHead: basis.contentHead,
          expectedProtection: basis.protectionHead,
          expectedControl: basis.controlHead,
          expectedControlEpoch: basis.controlEpoch,
          expectedRuleRevision: basis.ruleRevision,
          actingSubject: f.actor,
          reason: 'Keep the protected Work under its owner commands',
          evidence: [],
        }),
        201,
      );
    };
    await protect(sao.web);
    expect((await change(sao.web.work, recoveredHead, [])).status).toBe(404);
    expect(
      (
        await f.nativeFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(sao.web.work)} <${RV}semanticHead> ${iri(recoveredHead)} } }`)
      ).boolean,
    ).toBe(true);
    // Protection committed after the precheck also prevents a later semantic edit.
    let protectionRace = false;
    f.env.fuseki = new Proxy(originalGraph, {
      get(target, property) {
        if (property === 'commandWithReceipt')
          return async (envelope: Parameters<typeof target.commandWithReceipt>[0]) => {
            if (
              !protectionRace &&
              envelope.update.includes('a rv:SemanticRevision, rv:RevisionAnchor')
            ) {
              protectionRace = true;
              await protect(sao.volume1);
            }
            return target.commandWithReceipt(envelope);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect((await change(sao.volume1.work, concurrentWinner.revision, properties)).status).toBe(
        404,
      );
      expect(protectionRace).toBe(true);
    } finally {
      f.env.fuseki = originalGraph;
    }
    expect(
      (
        await f.nativeFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(sao.volume1.work)} <${RV}semanticHead> ${iri(concurrentWinner.revision)} } }`)
      ).boolean,
    ).toBe(true);
    await protect(game);
    expect((await change(game.work, game.workRevision, properties)).status).toBe(404);
    expect(
      (
        await f.nativeFuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(game.work)} <${RV}semanticHead> ?head } }`)
      ).boolean,
    ).toBe(false);

    // One command-created Statement proves the real owner path. The large
    // inventory extends that admitted graph shape as a deterministic read fixture.
    await f.grant(`statement:speak:${f.actor}`, 'statement.record');
    await f.grant('classification:decide:global', 'statement.decide');
    await ensureGlobalClassificationContext(f.env);
    const spoken = await f.json<{ statement: string; revision: string }>(
      await f.call('POST', '/v1/statements', {
        profile: 'statement-v1',
        speaker: { kind: 'personal' },
        subject: sao.bunko.work,
        predicate: 'https://example.org/zCommandFact',
        relationDefinition: 'https://example.org/definition',
        value: {
          kind: 'literal',
          lexical: 'API recorded',
          datatype: `${XSD}string`,
          language: null,
        },
        applicability: ['https://example.org/qualifier'],
        interpretation: { kind: 'selected' },
        evidence: ['https://example.org/source'],
        actingSubject: f.actor,
      }),
      201,
    );
    await f.json(
      await f.call('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1',
        target: { kind: 'statement', statement: spoken.statement },
        acceptance: { kind: 'global' },
        expectedDecisionHead: null,
        outcome: 'accepted',
        actingSubject: f.actor,
      }),
      201,
    );
    const inventoryDescription = await f.json<Change>(
      await change(sao.bunko.work, edited.revision, [
        { ...properties[0], value: { kind: 'integer', lexical: '2008' } },
        ...Array.from({ length: 26 }, (_, n) => ({
          predicate: `https://example.org/aHidden${n}`,
          value: { kind: 'resource', ref: unknown.component },
        })),
      ]),
      200,
    );
    const expected = new Set([spoken.statement]);
    const hidden: string[] = [];
    for (let offset = 0; offset < 1051; offset += 100) {
      const current: string[] = [],
        revisions: string[] = [];
      for (let n = offset; n < Math.min(offset + 100, 1051); n++) {
        const statement = nativeId(),
          head = nativeId(),
          decision = nativeId();
        const privateValue = n >= 1001 && n < 1050;
        const predicate = privateValue
          ? 'https://example.org/aPrivate'
          : `https://example.org/p${n % 7}`;
        const rejected = n === 1050;
        const value = privateValue
          ? { kind: 'resource' as const, iri: unknown.component }
          : {
              kind: 'literal' as const,
              lexical: String(n),
              datatype: 'https://example.org/UnfamiliarDatatype',
              language: null,
            };
        const meaningKey = statementMeaningKey({
          subject: sao.bunko.work,
          predicate,
          relationDefinition: 'https://example.org/definition',
          interpretationDefinitions: [],
          value,
          applicability: [],
        });
        const slot = decisionSlotIri(
          { kind: 'statement', statement },
          GLOBAL_CLASSIFICATION_CONTEXT,
        );
        if (privateValue || rejected) hidden.push(statement);
        else expected.add(statement);
        current.push(`${iri(statement)} a <${RDF}Statement> ; <${RDF}subject> ${iri(sao.bunko.work)} ;
          <${RDF}predicate> <${predicate}> ; <${RDF}object> ${privateValue ? iri(unknown.component) : `${lit(String(n))}^^<https://example.org/UnfamiliarDatatype>`} ;
          <${RV}relationDefinition> <https://example.org/definition> ; <${RV}speaker> ${iri(f.actor)} ;
          <${RV}meaningKey> <${meaningKey}> ; <${RV}statementState> <${RV}Active> ; <${RV}head> ${iri(head)} .
          <${slot}> a <${RV}DecisionSlot> ; <${RV}decisionTarget> ${iri(statement)} ; <${RV}targetKind> <${RV}StatementTarget> ;
          <${RV}acceptanceContext> <${GLOBAL_CLASSIFICATION_CONTEXT}> ; <${RV}decisionHead> ${iri(decision)} .`);
        revisions.push(`${iri(head)} a <${RV}StatementRevision> ; <${RV}component> ${iri(statement)} .
          ${iri(decision)} a <${RV}StatementDecision> ; <${RV}component> <${slot}> ;
          <${RV}outcome> <${RV}${rejected ? 'Rejected' : 'Accepted'}> .`);
      }
      await f.nativeFuseki
        .update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${current.join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${revisions.join('\n')} } }`);
    }
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      unknownGrant,
    ]);
    expect((await read(unknown.component)).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(600_000);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await f.json<Statements>(
        await read(
          sao.bunko.work,
          'statements',
          `&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
        200,
      );
      expect(Value.Check(subjectStatementPage, page)).toBe(true);
      const items = page.groups.flatMap((group) => group.items);
      if (page.nextCursor) expect(items.length).toBe(20);
      expect(page.count).toEqual({ value: items.length, kind: 'exact-page', total: null });
      for (const item of items)
        if (item.kind === 'statement') {
          expect(seen.has(item.statement)).toBe(false);
          seen.add(item.statement);
          if (item.statement === spoken.statement)
            expect(item).toMatchObject({
              qualifiers: { applicability: ['https://example.org/qualifier'] },
              sources: ['https://example.org/source'],
            });
        }
      for (const privateId of [unknown.component, ...hidden])
        expect(JSON.stringify(page)).not.toContain(privateId);
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    expect(pages).toBeGreaterThan(50);
    expect([...seen].sort()).toEqual([...expected].sort());
    const first = await f.json<Statements>(await read(sao.bunko.work, 'statements'), 200);
    expect(first.nextCursor).toBeTruthy();
    expect((await read(recipe.work, 'statements', `&cursor=${first.nextCursor}`)).status).toBe(400);
    expect((await read(sao.bunko.work, 'statements', '&cursor=invalid')).status).toBe(400);
    await change(sao.bunko.work, inventoryDescription.revision, []);
    expect((await read(sao.bunko.work, 'statements', `&cursor=${first.nextCursor}`)).status).toBe(
      409,
    );
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
