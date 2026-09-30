import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Static } from 'typebox';
import { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { contextFixture, nativeId, shortId, RV } from './context-fixture.ts';

type Page = Static<typeof subjectStatementPage>;
type Statement = { statement: string; meaningKey: string; revision: string };
type Decision = { decision: string; slot: string };

test('G-629: subject inventory respects local decisions, withdrawn inheritance, qualified facts and unreadable Context pins', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.globalAcceptance();
    const work = await f.work('Contextual SAO description');
    const realm = await f.realm('SAO interpretation');
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.grant('classification:decide:global', 'statement.decide');
    await f.grant(`classification:decide:${realm.realm}`, 'statement.decide');
    const record = () =>
      f.call('POST', '/v1/statements', {
        profile: 'statement-v1',
        speaker: { kind: 'personal' },
        subject: work.work,
        predicate: 'https://example.org/unknownProperty',
        relationDefinition: 'https://example.org/meaning',
        value: {
          kind: 'literal',
          lexical: '零',
          datatype: 'https://example.org/UnfamiliarDatatype',
          language: null,
        },
        applicability: [],
        interpretation: { kind: 'selected' },
        evidence: ['https://example.org/reference'],
        actingSubject: f.actorA,
      });
    const statement = await f.json<Statement>(await record(), 201);
    const read = (context?: string) =>
      f.call(
        'GET',
        `/v1/resources/${shortId(work.work!)}/statements` +
          `?actingSubject=${encodeURIComponent(f.actorA)}${context ? `&context=${encodeURIComponent(context)}` : ''}`,
      );
    const items = async (context?: string) =>
      (await f.json<Page>(await read(context), 200)).groups.flatMap((group) => group.items);
    const decide = (
      target: object,
      acceptance: object,
      outcome: string,
      expectedDecisionHead: string | null = null,
    ) =>
      f.call('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1',
        target,
        acceptance,
        outcome,
        expectedDecisionHead,
        actingSubject: f.actorA,
      });
    expect(await items()).toEqual([]);
    const target = {
      kind: 'qualified-fact',
      meaningKey: statement.meaningKey,
      support: [statement.statement],
    };
    await f.json(await decide(target, { kind: 'global' }, 'accepted'), 201);
    expect(await items()).toEqual([
      expect.objectContaining({
        kind: 'statement',
        statement: statement.statement,
        value: {
          kind: 'literal',
          lexical: '零',
          datatype: 'https://example.org/UnfamiliarDatatype',
          language: null,
        },
        sources: ['https://example.org/reference'],
        acceptance: expect.objectContaining({ source: 'global' }),
      }),
    ]);
    expect(await items(realm.acceptanceContext)).toEqual([
      expect.objectContaining({
        statement: statement.statement,
        acceptance: expect.objectContaining({ source: 'inherited-global' }),
      }),
    ]);
    const local = await f.json<Decision>(
      await decide(target, { kind: 'realm', realm: realm.realm }, 'rejected'),
      201,
    );
    expect(await items(realm.acceptanceContext)).toEqual([]);
    const withdrawn = await f.json<Decision>(
      await decide(target, { kind: 'realm', realm: realm.realm }, 'withdrawn', local.decision),
      201,
    );
    expect(await items(realm.acceptanceContext)).toHaveLength(1);
    // A corrupt local head must block inheritance rather than silently becoming absent.
    await f.env.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(withdrawn.decision)} <${RV}outcome> <${RV}Withdrawn> } }`);
    expect(await items(realm.acceptanceContext)).toEqual([]);
    // The first descriptor inventory has no statement total to reveal private rows.
    const hiddenContext = nativeId(),
      hiddenRevision = nativeId();
    await f.env.fuseki.update(`INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(statement.statement)} <${RV}semanticContextRevision> ${iri(hiddenRevision)} .
        ${iri(hiddenContext)} <${RV}disclosure> <${RV}Private> . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(hiddenRevision)} a <${RV}ContextSemanticRevision> ;
        <${RV}component> ${iri(hiddenContext)} . } }`);
    expect(await items()).toEqual([]);
    const hidden = await f.json<Page>(await read(), 200);
    expect(hidden.count).toEqual({ value: 0, kind: 'exact-page', total: null });
    expect(JSON.stringify(hidden)).not.toContain(hiddenContext);
    expect((await read(nativeId())).status).toBe(404);
  } finally {
    await f.close();
    rmSync(f.env.objectDirectory, { recursive: true, force: true });
  }
}, 120_000);
