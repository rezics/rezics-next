import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { StatementRead } from '../../../services/main/src/modules/statement/read.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

const PROV = 'http://www.w3.org/ns/prov#';
type Written = { statement: string; revision: string; meaningKey: string; replayed: boolean };

test('Statement PROV export keeps speaker attribution and exact revision activity separate from private principals', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const work = await f.work('Statement provenance');
    const realm = await f.realm('Provenance speaker');
    await f.grant(`statement:speak:${realm.realm}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.grant(`statement:speak:${realm.realm}`, 'statement.withdraw', f.actorB, f.principalB);
    const meaning = { subject: work.mainVersion, predicate: 'https://example.org/provenance-fact',
      relationDefinition: nativeId(), value: { kind: 'literal', lexical: 'a retained assertion',
        datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [] };
    const body = { profile: 'statement-v1', speaker: { kind: 'realm', realm: realm.realm },
      ...meaning, actingSubject: f.actorA };
    const key = randomUUID();
    const recorded = await f.json<Written>(await f.call('POST', '/v1/statements', body, key), 201);
    const personal = await f.json<Written>(await f.call('POST', '/v1/statements', {
      ...body, speaker: { kind: 'personal' } }), 201);
    expect(personal.statement).not.toBe(recorded.statement);
    expect(personal.meaningKey).toBe(recorded.meaningKey);
    const path = `/v1/statements/${recorded.statement.slice(-36)}`;
    const read = async () => f.json<StatementRead>(await f.call('GET', path, undefined, randomUUID(), null), 200);
    const provenance = async (revision: string) => {
      const rows = (await f.env.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?operation ?recorder WHERE { GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(revision)} rv:component ${iri(recorded.statement)} ;
            rv:operation ?operation ; rv:recordedBy ?recorder . } }`)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      return { operation: rows[0]!.operation!.value, recorder: rows[0]!.recorder!.value };
    };
    const initial = await provenance(recorded.revision);
    expect(initial.recorder).toBe(f.actorA);
    const assertExport = (result: StatementRead, revision: string, activity: string, recorder: string) => {
      expect(result.export).toMatchObject({ '@id': recorded.statement,
        [`${PROV}wasAttributedTo`]: [{ '@id': realm.realm }],
        [`${RV}head`]: [{ '@id': revision, '@type': [`${RV}StatementRevision`, `${PROV}Entity`],
          [`${PROV}wasGeneratedBy`]: [{ '@id': activity, '@type': [`${PROV}Activity`],
            [`${PROV}wasAssociatedWith`]: [{ '@id': recorder }] }] }] });
      const exported = JSON.stringify(result.export);
      for (const privateValue of [f.principalA, f.principalB, f.account.a.id, f.account.b.id,
        `${PROV}actedOnBehalfOf`, `${RV}principal`, 'authorityEpoch', 'admissionId']) {
        expect(exported).not.toContain(privateValue);
      }
      expect(result.export[meaning.predicate]).toBeUndefined();
    };
    const before = await read();
    assertExport(before, recorded.revision, initial.operation, f.actorA);
    const replay = await f.json<Written>(await f.call('POST', '/v1/statements', body, key), 200);
    expect(replay).toMatchObject({ statement: recorded.statement, revision: recorded.revision, replayed: true });
    expect((await read()).export).toEqual(before.export);
    const withdrawn = await f.json<{ revision: string }>(await f.call('POST', `${path}/withdrawals`, {
      profile: 'statement-v1', speaker: body.speaker, expectedHead: recorded.revision,
      actingSubject: f.actorB }, randomUUID(), f.account.tokenB), 201);
    const successor = await provenance(withdrawn.revision);
    expect(successor.operation).not.toBe(initial.operation);
    expect(successor.recorder).toBe(f.actorB);
    const after = await read();
    expect(after.state).toBe('withdrawn');
    assertExport(after, withdrawn.revision, successor.operation, f.actorB);
    expect(await provenance(recorded.revision)).toEqual(initial);
  } finally { await f.close(); }
}, 120_000);
