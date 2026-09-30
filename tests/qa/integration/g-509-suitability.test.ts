import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import {
  SuitabilityStore,
  PLATFORM_ACTION,
  PLATFORM_SCOPE,
  SUITABILITY_COST,
} from '../../../services/main/src/modules/suitability/store.ts';
import type {
  Assessed,
  StoredAssessment,
  Command,
} from '../../../services/main/src/modules/suitability/contract.ts';
import type { Labels } from '../../../services/main/src/modules/suitability/policy.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';

interface Write {
  assessment: Assessed;
  replayed: boolean;
}
interface Read {
  viewer: {
    signedIn: boolean;
    age: 'unknown';
    country: null;
    optIns: { sexual: false; grotesque: false; available: false; reason: string };
  };
  items: Array<{
    target: { resource: string; work: string | null; base: string };
    assessment: StoredAssessment;
    eligible: boolean;
    reasons: string[];
  }>;
}

test('G-509: real API assessment chains, authority, retries, concurrency and evidence stay bounded', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const preparation = Date.now();
  const directory = resolve('.temp', `g-509-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read governance:decide',
  );
  let ownerStatements = 0;
  let failInsert = false;
  let expireBeforeInsert = false;
  const statements: string[] = [];
  const connect = f.accessPool.connect.bind(f.accessPool);
  const countedPool = new Proxy(f.accessPool, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const client = await connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === 'query')
                return async (sql: string, values?: unknown[]) => {
                  if (
                    sql.includes('suitability_assessment') ||
                    sql.includes('pg_advisory_xact_lock')
                  ) {
                    ownerStatements++;
                    statements.push(sql);
                  }
                  if (sql.includes('INSERT INTO access.suitability_assessment') && failInsert) {
                    failInsert = false;
                    throw new Error('Interrupted before suitability insert');
                  }
                  if (
                    sql.includes('INSERT INTO access.suitability_assessment') &&
                    expireBeforeInsert
                  ) {
                    expireBeforeInsert = false;
                    await delay(1200);
                  }
                  return client.query(sql, values);
                };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }) as PoolClient;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
  const store = new SuitabilityStore(countedPool, f.access);
  const content = new ContentCore(f.pool);
  const deps: MainWorkDependencies = {
    environment: f.env,
    account: f.account.verifier,
    access: f.access,
    suitability: store,
    content,
    contentAuthoring: content,
    mediaAccess: new MediaAccessBatchReader(f.accessPool, f.env.fuseki),
  };
  const app = createMainApp(f.env.fuseki, deps);
  const call = (
    method: string,
    path: string,
    body?: object,
    key = randomUUID(),
    authenticated = true,
  ) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
          'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return response.json() as Promise<T>;
  };
  const write = (
    target: string,
    labels: Labels,
    expectedRevision: string | null,
    basis: Command['basis'] = 'author',
    key = randomUUID(),
  ) =>
    call(
      'PUT',
      `/v1/suitability/${shortId(target)}`,
      { actingSubject: f.actor, labels, expectedRevision, basis },
      key,
    );
  const read = (targets: string[], authenticated = true) =>
    call(
      'POST',
      '/v1/suitability/reads',
      { targets, ...(authenticated ? { actingSubject: f.actor } : {}) },
      randomUUID(),
      authenticated,
    );
  try {
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const work = await json<{ work: string; mainVersion: string }>(
      await call('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        language: 'en',
        title: 'Suitability across admitted resources',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: f.actor,
      }),
      201,
    );
    const editGrant = await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(
      await call('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: work.work,
        language: 'en',
        body: 'A suitability test publication',
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await json<{ publicationDecision: string }>(
      await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    await json(
      await call('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work,
        contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer',
        actingSubject: f.actor,
      }),
      201,
    );
    const releaseId = nativeId();
    const release = await json<{ release: string }>(
      await call('PUT', `/v1/works/${shortId(work.work)}/releases/${shortId(releaseId)}`, {
        profile: 'release-v1',
        expectedHead: null,
        actingSubject: f.actor,
        id: releaseId,
        kind: 'formal',
        status: 'official',
        contentLanguages: ['en'],
        isTranslation: false,
        originalLanguages: [],
        titleLanguage: 'en',
        tracklistLanguage: null,
        title: { value: 'Assessed release', language: 'en' },
        editionStatement: null,
        publisher: 'Test publisher',
        publicationYear: 2026,
        isbn13: null,
        originalUrl: null,
        fixedRelease: null,
        coverage: null,
        evidence: null,
      }),
    );
    await f.grant('semantic:create:root', 'semantic.change');
    const character = await json<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: f.actor,
        state: {
          component: 'resource',
          types: ['https://rezics.com/vocab/Character'],
          properties: [
            {
              predicate: 'https://schema.org/name',
              value: {
                kind: 'language-string',
                lexical: 'Suitability character',
                language: 'en',
                direction: 'ltr',
              },
            },
          ],
        },
      }),
      201,
    );
    await f.grant(`semantic:read:${character.component}`, 'semantic.read');
    const targets = [work.work, release.release, character.component];
    const unknown = await json<Read>(await read(targets));
    expect(unknown.items.map((item) => item.assessment)).toEqual(
      targets.map(() => ({ status: 'unassessed' })),
    );
    expect(unknown.items.every((item) => item.eligible)).toBe(true);
    expect(unknown.viewer).toEqual({
      signedIn: true,
      age: 'unknown',
      country: null,
      optIns: {
        sexual: false,
        grotesque: false,
        available: false,
        reason: 'age_evidence_unavailable',
      },
    });
    expect(JSON.stringify(unknown)).not.toContain('general');

    // Characters have no Work edit envelope. A generic semantic edit grant is insufficient.
    expect((await write(character.component, ['r15'], null)).status).toBe(403);
    expect((await write(character.component, ['r15'], null, 'platform')).status).toBe(403);
    const platformGrant = await f.grant(PLATFORM_SCOPE, PLATFORM_ACTION);
    await f.accessPool.query(
      "UPDATE access.permission_grant SET valid_until = 'infinity' WHERE id = $1",
      [platformGrant],
    );
    await f.accessPool.query(
      `UPDATE access.representation SET valid_until = 'infinity'
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3`,
      [f.principalId, f.actor, PLATFORM_ACTION],
    );
    const heads: Assessed[] = [];
    for (const [index, target] of targets.entries()) {
      const basis = index === 2 ? 'platform' : 'author';
      const key = randomUUID();
      ownerStatements = 0;
      const created = await json<Write>(await write(target, ['r15'], null, basis, key));
      expect(ownerStatements).toBeLessThanOrEqual(SUITABILITY_COST.writeStatements);
      expect(created.replayed).toBe(false);
      expect(created.assessment).toMatchObject({
        status: 'assessed',
        labels: ['r15'],
        basis,
        predecessor: null,
        assessor: f.actor,
        sourceId: null,
      });
      const replay = await json<Write>(await write(target, ['r15'], null, basis, key));
      expect(replay).toEqual({ ...created, replayed: true });
      expect((await write(target, [], null, basis, key)).status).toBe(409);
      expect((await write(target, [], null, basis)).status).toBe(409);
      const corrected = await json<Write>(
        await write(target, [], created.assessment.revision, basis),
      );
      expect(corrected.assessment.predecessor).toBe(created.assessment.revision);
      // A lost response still replays the original revision after a correction.
      expect(await json<Write>(await write(target, ['r15'], null, basis, key))).toEqual({
        ...created,
        replayed: true,
      });
      heads.push(corrected.assessment);
    }
    const assessed = await json<Read>(await read(targets));
    expect(assessed.items.map((item) => item.assessment)).toEqual(heads);
    expect(assessed.items.map((item) => item.target.base)).toEqual(['work', 'release', 'resource']);
    expect(assessed.items.map((item) => item.target.work)).toEqual([work.work, work.work, null]);

    // Platform restrictions remain a floor, including across stronger author heads.
    const adult = await json<Write>(
      await write(work.work, ['r18'], heads[0]!.revision, 'platform'),
    );
    expect((await write(work.work, [], adult.assessment.revision)).status).toBe(403);
    expect((await write(work.work, ['r18g'], adult.assessment.revision)).status).toBe(403);
    const stronger = await json<Write>(
      await write(work.work, ['r18', 'r18g'], adult.assessment.revision),
    );
    expect((await write(work.work, ['r18g'], stronger.assessment.revision)).status).toBe(403);
    const anonymous = await json<Read>(await read([work.work], false));
    expect(anonymous.viewer.signedIn).toBe(false);
    expect(anonymous.items[0]).toMatchObject({
      eligible: false,
      assessment: { labels: ['r18', 'r18g'] },
    });
    expect(anonymous.items[0]!.reasons).toContain('sign_in_required');
    const signedIn = await json<Read>(await read([work.work]));
    expect(signedIn.items[0]!.eligible).toBe(false);
    expect(signedIn.items[0]!.reasons).toContain('age_unknown');
    expect(signedIn.items[0]!.reasons).toContain('country_unknown');

    // Authority is checked even for exact replay; grants are never retry tokens.
    const replayKey = randomUUID();
    await json<Write>(await write(release.release, [], heads[1]!.revision, 'author', replayKey));
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      editGrant,
    ]);
    expect((await write(release.release, [], heads[1]!.revision, 'author', replayKey)).status).toBe(
      403,
    );
    await f.grant(`work:edit:${work.work}`, 'work.edit');

    // Concurrent new keys at one revision produce exactly one successor.
    const current = (await json<Read>(await read([release.release]))).items[0]!
      .assessment as Assessed;
    const raced = await Promise.all([
      write(release.release, ['r15'], current.revision),
      write(release.release, ['r18g'], current.revision),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await json<Write>(raced.find((response) => response.status === 200)!);
    const sameKey = randomUUID();
    const retried = await Promise.all([
      write(release.release, [], winner.assessment.revision, 'author', sameKey),
      write(release.release, [], winner.assessment.revision, 'author', sameKey),
    ]);
    const duplicate = await Promise.all(retried.map((response) => json<Write>(response)));
    expect(duplicate[0]!.assessment).toEqual(duplicate[1]!.assessment);
    expect(duplicate.map((result) => result.replayed).sort()).toEqual([false, true]);
    // A key used simultaneously for different targets binds exactly one intent.
    const conflictingKey = randomUUID();
    const conflicting = await Promise.all([
      write(work.work, ['r18'], stronger.assessment.revision, 'platform', conflictingKey),
      write(character.component, ['r18g'], heads[2]!.revision, 'platform', conflictingKey),
    ]);
    expect(conflicting.map((response) => response.status).sort()).toEqual([200, 409]);

    // An interrupted owner transaction leaves neither a revision nor a consumed key.
    const beforeFailure = duplicate[0]!.assessment;
    const faultKey = randomUUID();
    failInsert = true;
    expect(
      (await write(release.release, ['r15'], beforeFailure.revision, 'author', faultKey)).status,
    ).toBe(503);
    const afterFailure = (await json<Read>(await read([release.release]))).items[0]!.assessment;
    expect(afterFailure).toEqual(beforeFailure);
    const recovered = await json<Write>(
      await write(release.release, ['r15'], beforeFailure.revision, 'author', faultKey),
    );
    expect(recovered.replayed).toBe(false);

    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      expect((await read([release.release])).status).toBe(503);
      expect((await write(release.release, [], recovered.assessment.revision)).status).toBe(503);
    } finally {
      await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    }
    expect((await json<Read>(await read([release.release]))).items[0]!.assessment).toEqual(
      recovered.assessment,
    );

    ownerStatements = 0;
    statements.length = 0;
    const batch = await json<Read>(
      await read(Array.from({ length: 64 }, (_, index) => targets[index % 3]!)),
    );
    expect(batch.items).toHaveLength(64);
    expect(batch.items.map((item) => item.target.resource)).toEqual(
      Array.from({ length: 64 }, (_, index) => targets[index % 3]!),
    );
    expect(ownerStatements).toBe(SUITABILITY_COST.readStatements);
    expect(statements[0]).toContain('ORDER BY revision_number DESC LIMIT 1');
    expect((await read(Array.from({ length: 65 }, () => work.work))).status).toBe(400);
    ownerStatements = 0;
    expect((await read([work.work, nativeId()])).status).toBe(404);
    expect(ownerStatements).toBe(0);
    expect((await read([character.component], false)).status).toBe(404);
    expect((await write(nativeId(), [], null, 'platform')).status).toBe(404);
    expect((await write(work.mainVersion, [], null, 'platform')).status).toBe(422);
    expect(
      (
        await call(
          'POST',
          '/v1/suitability/reads',
          { targets: [work.work], age: 'adult', country: 'US' },
          randomUUID(),
          false,
        )
      ).status,
    ).toBe(400);
    const beforeExpiry = (await json<Read>(await read([character.component]))).items[0]!
      .assessment as Assessed;
    const expiryKey = randomUUID();
    await f.accessPool.query(
      "UPDATE access.permission_grant SET valid_until = clock_timestamp() + interval '1 second' WHERE id = $1",
      [platformGrant],
    );
    expireBeforeInsert = true;
    expect(
      (await write(character.component, [], beforeExpiry.revision, 'platform', expiryKey)).status,
    ).toBe(403);
    expect(expireBeforeInsert).toBe(false);
    expect((await json<Read>(await read([character.component]))).items[0]!.assessment).toEqual(
      beforeExpiry,
    );
    await f.accessPool.query(
      "UPDATE access.permission_grant SET valid_until = 'infinity' WHERE id = $1",
      [platformGrant],
    );
    expect(
      (
        await json<Write>(
          await write(character.component, [], beforeExpiry.revision, 'platform', expiryKey),
        )
      ).replayed,
    ).toBe(false);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      platformGrant,
    ]);
    expect((await write(character.component, [], heads[2]!.revision, 'platform')).status).toBe(403);

    // Schema rejects rewrites, deletion, forks and cross-resource predecessors.
    const row = (
      await f.accessPool.query<{ id: string; revision_number: string }>(
        `SELECT id, revision_number
      FROM access.suitability_assessment WHERE target = $1 ORDER BY revision_number DESC LIMIT 1`,
        [release.release],
      )
    ).rows[0]!;
    await expect(
      f.accessPool.query('UPDATE access.suitability_assessment SET labels = $1 WHERE id = $2', [
        [],
        row.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.accessPool.query('DELETE FROM access.suitability_assessment WHERE id = $1', [row.id]),
    ).rejects.toMatchObject({ code: '23514' });
    const insert = (
      target: string,
      predecessor: string | null,
      predecessorNumber: string | null,
      revisionNumber: string,
    ) =>
      f.accessPool.query(
        `INSERT INTO access.suitability_assessment
        (id,target,labels,basis,assessor,principal_id,predecessor,predecessor_number,revision_number,
         authority_proof,idempotency_key,request_digest) VALUES ($1,$2,'{}','author',$3,$4,$5,$6,$7,'{}',$8,$9)`,
        [
          randomUUID(),
          target,
          f.actor,
          f.principalId,
          predecessor,
          predecessorNumber,
          revisionNumber,
          randomUUID(),
          '0'.repeat(64),
        ],
      );
    await expect(insert(release.release, null, null, '1')).rejects.toMatchObject({ code: '23505' });
    await expect(
      insert(
        nativeId(),
        row.id,
        row.revision_number,
        (BigInt(row.revision_number) + 1n).toString(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      insert(
        release.release,
        row.id,
        row.revision_number,
        (BigInt(row.revision_number) + 2n).toString(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const earlier = (
      await f.accessPool.query<{
        predecessor: string;
        predecessor_number: string;
        revision_number: string;
      }>(
        'SELECT predecessor, predecessor_number, revision_number FROM access.suitability_assessment WHERE id = $1',
        [row.id],
      )
    ).rows[0]!;
    await expect(
      insert(
        release.release,
        earlier.predecessor,
        earlier.predecessor_number,
        earlier.revision_number,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
