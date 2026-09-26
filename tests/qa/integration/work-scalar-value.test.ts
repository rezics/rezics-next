import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { sameScalar, scalarExport, scalarFromBinding, SCALAR_PREDICATE, type WorkScalarValue }
  from '../../../services/main/src/modules/work/scalar-value.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

type ScalarRead = { work: string; revision: string; scalarValue?: WorkScalarValue;
  export: Record<string, unknown>; sourcePosition: { sequence: string } };
type ScalarWrite = { work: string; revision: string; predecessor: string;
  scalarValue?: WorkScalarValue; replayed: boolean };

test('MODEL02 template: real Account/Access/Main/Jena scalar write, exact read, denial and stale guard', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `work-scalar-${randomUUID()}`));
  try {
    const health = await f.nativeFuseki.commandHealth();
    expect(health.profiles['work-metadata-v1']).toBe(profileRegistry['work-metadata-v1'].sha256);
    const created = await f.json<{ work: string; workRevision: string; mainVersion: string }>(
      await f.call('POST', '/v1/works', { profile: 'metadata-only-v1', title: 'Scalar Work',
        actingSubject: f.actor }), 201);
    const path = `/v1/works/${shortId(created.work)}/scalar-value`;
    const readPath = `${path}?actingSubject=${encodeURIComponent(f.actor)}`;
    const initialBody = { profile: 'work-scalar-state-v1', expectedHead: created.workRevision,
      scalarValue: { kind: 'integer', lexical: '0' }, actingSubject: f.actor };
    const key = `scalar-${randomUUID()}`;
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`work:edit:${created.work}`]);
    expect((await f.call('POST', path, initialBody, key, f.account.noScope)).status).toBe(401);
    expect((await f.call('POST', path, initialBody, key)).status).toBe(403);
    await f.grant(`work:edit:${created.work}`, 'work.edit');
    await f.grant(`work:read:${created.work}`, 'work.read');
    expect((await f.call('GET', readPath, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const initial = await f.json<ScalarRead>(await f.call('GET', readPath), 200);
    expect(initial).toMatchObject({ work: created.work, revision: created.workRevision,
      export: { '@id': created.work } });
    expect(Object.hasOwn(initial, 'scalarValue')).toBe(false);
    expect(Object.hasOwn(initial.export, SCALAR_PREDICATE)).toBe(false);
    const first = await f.json<ScalarWrite>(await f.call('POST', path, initialBody, key), 200);
    expect(first).toMatchObject({ predecessor: created.workRevision, replayed: false,
      scalarValue: { kind: 'integer', lexical: '0' } });
    expect((await f.json<ScalarWrite>(await f.call('POST', path, initialBody, key), 200)).revision)
      .toBe(first.revision);
    expect((await f.json<ScalarWrite>(await f.call('POST', path, { ...initialBody,
      scalarValue: { lexical: '0', kind: 'integer' } }, key), 200)).revision)
      .toBe(first.revision);
    expect((await f.call('POST', path, { ...initialBody,
      scalarValue: { kind: 'boolean', lexical: 'false' } }, key)).status).toBe(409);
    expect((await f.call('POST', path, { ...initialBody,
      scalarValue: { kind: 'unknown' } })).status).toBe(409);
    const current = await f.json<ScalarRead>(await f.call('GET', readPath), 200);
    expect(current).toMatchObject({ revision: first.revision, scalarValue: initialBody.scalarValue,
      export: { [SCALAR_PREDICATE]: [{ '@value': '0',
        '@type': 'http://www.w3.org/2001/XMLSchema#integer' }] } });
    const exactPath = `${path}/revisions/${shortId(first.revision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json<ScalarRead>(await f.call('GET', exactPath), 200)).toEqual(current);
    const graph = await f.env.fuseki.query(`SELECT ?value WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} <${SCALAR_PREDICATE}> ?value }
    }`);
    expect(graph.results?.bindings).toHaveLength(1);
    expect(graph.results?.bindings[0]?.value).toMatchObject({ type: 'literal', value: '0',
      datatype: 'http://www.w3.org/2001/XMLSchema#integer' });
    // Exact missing bytes are unavailable, never substituted with the current head.
    const manifest = (await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(first.revision)} rv:manifest ?manifest }
    }`)).results?.bindings[0]?.manifest?.value!;
    const manifestPath = join(f.env.objectDirectory, manifest.slice(-64));
    const saved = readFileSync(manifestPath);
    renameSync(manifestPath, `${manifestPath}.held`);
    try { expect((await f.call('GET', exactPath)).status).toBe(503); }
    finally { renameSync(`${manifestPath}.held`, manifestPath); }
    writeFileSync(manifestPath, 'corrupt');
    try { expect((await f.call('GET', exactPath)).status).toBe(503); }
    finally { writeFileSync(manifestPath, saved); }

    let previous = first.revision;
    const variants: readonly (WorkScalarValue | undefined)[] = [
      { kind: 'boolean', lexical: 'false' }, { kind: 'string', lexical: '' },
      undefined, { kind: 'unknown' }, { kind: 'no-value' },
    ];
    const exact = (revision: string) =>
      `${path}/revisions/${shortId(revision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const oldValues: Array<{ revision: string; value: WorkScalarValue | undefined }> = [
      { revision: created.workRevision, value: undefined },
      { revision: first.revision, value: { kind: 'integer', lexical: '0' } },
    ];
    for (const value of variants) {
      const body = { profile: 'work-scalar-state-v1', expectedHead: previous,
        ...(value === undefined ? {} : { scalarValue: value }), actingSubject: f.actor };
      const written = await f.json<ScalarWrite>(await f.call('POST', path, body), 200);
      expect(written.predecessor).toBe(previous);
      expect(sameScalar(written.scalarValue, value)).toBe(true);
      const now = await f.json<ScalarRead>(await f.call('GET', readPath), 200);
      expect(now.revision).toBe(written.revision);
      expect(sameScalar(now.scalarValue, value)).toBe(true);
      expect(now.export).toEqual(scalarExport(created.work, value));
      expect(await f.json<ScalarRead>(await f.call('GET', exact(written.revision)), 200)).toEqual(now);
      const queried = await f.env.fuseki.query(`SELECT ?value WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} <${SCALAR_PREDICATE}> ?value }
      }`);
      const terms = queried.results?.bindings ?? [];
      expect(terms).toHaveLength(value === undefined ? 0 : 1);
      expect(sameScalar(scalarFromBinding(terms[0]?.value), value)).toBe(true);
      oldValues.push({ revision: written.revision, value });
      previous = written.revision;
    }
    for (const old of oldValues) {
      const retained = await f.json<ScalarRead>(await f.call('GET', exact(old.revision)), 200);
      expect(sameScalar(retained.scalarValue, old.value)).toBe(true);
      expect(retained.export).toEqual(scalarExport(created.work, old.value));
    }
    const mainBefore = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.mainVersion)} rv:head ?head } }`);
    const titleBody = {
      profile: 'metadata-only-v1', work: created.work, expectedHead: previous,
      title: 'Scalar Work title edit', actingSubject: f.actor };
    const titleKey = `title-${randomUUID()}`;
    const title = await f.json<{ revision: string }>(await f.call('POST', '/v1/content-edits',
      titleBody, titleKey), 200);
    expect((await f.json<{ revision: string }>(await f.call('POST', '/v1/content-edits',
      titleBody, titleKey), 200)).revision).toBe(title.revision);
    expect((await f.call('POST', '/v1/content-edits', { ...titleBody,
      title: 'Changed title intent' }, titleKey)).status).toBe(409);
    expect(title.revision).not.toBe(previous);
    const afterTitle = await f.json<ScalarRead>(await f.call('GET', readPath), 200);
    expect(afterTitle.revision).toBe(title.revision);
    expect(afterTitle.scalarValue).toEqual({ kind: 'no-value' });
    const mainAfter = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(created.mainVersion)} rv:head ?head } }`);
    expect(mainAfter).toEqual(mainBefore);
    const afterTitleScalar = await f.json<ScalarWrite>(await f.call('POST', path,
      { profile: 'work-scalar-state-v1', expectedHead: title.revision,
        scalarValue: { lexical: '0', kind: 'integer' }, actingSubject: f.actor }), 200);
    const retainedTitle = await readExactWorkRevision(f.env, afterTitleScalar.revision,
      async owner => owner === created.work);
    expect(retainedTitle.title).toBe('Scalar Work title edit');
    expect(retainedTitle.mainVersion).toBe(created.mainVersion);
    expect(retainedTitle.scalarValue).toEqual({ kind: 'integer', lexical: '0' });
    expect((await f.json<ScalarRead>(await f.call('GET', readPath), 200)).scalarValue)
      .toEqual({ kind: 'integer', lexical: '0' });
    expect((await f.call('GET', exact(previous), undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
  } finally { await f.close(); }
}, 180_000);
