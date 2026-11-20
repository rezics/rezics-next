import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { publicFilterCoverageKeys } from '../../src/semantic/public-filter-coverage-pending.ts';
import { identityFixture, digest, release } from '../semantic/identity-fixture.ts';
import type { identityEpochDatabase } from '../semantic/support/identity-epoch.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

export async function retentionFixture(db: Awaited<ReturnType<typeof identityEpochDatabase>>) {
  configureTestReceiptKeys(db.pool);
  const f = await identityFixture(db.pool, db.admin);
  async function book(home: number) {
    const route = home * 16;
    const key = randomUUID();
    return createSubject(db.pool, {
      actor: f.editor,
      target: { route, id: newId(route) },
      idempotencyKey: key,
      digest: digest(key),
      release,
      item: {
        type: 'bf:Instance',
        labels: { en: 'Retention Book' },
        statements: {
          'schema:translator': [{ property: { id: 'schema:translator' }, value: { type: 'somevalue' } }],
        },
      },
      authorization: await f.authorization('subject:create'),
    });
  }
  const resident = await book(0);
  const source = randomUUID(),
    configuration = randomUUID(),
    definition = randomUUID();
  const job = randomUUID(),
    bootstrap = randomUUID(),
    incarnation = randomUUID(),
    target = 'retention-subjects-g1';
  const meaning = release.digest;
  const dependencyKeys = [
    { kind: 'field', field: 'labels' },
    { kind: 'field', field: 'aliases' },
    { kind: 'field', field: 'descriptions' },
    { kind: 'order', order: 'name' },
  ] as const;
  const keys = publicFilterCoverageKeys(dependencyKeys, true);
  await db.admin.query(
    `INSERT INTO semantic.public_filter_source(partition_no,source_id,configuration,route_digest,owner_epoch,family)
    VALUES(0,$1,$2,$3,1,'global-subject-v1')`,
    [source, configuration, digest(source).toString('hex')],
  );
  await db.admin.query(
    `INSERT INTO semantic.public_filter_read_definition
    (partition_no,read_definition,source_id,configuration,release_digest,capture_digest,capture,dependency_keys,coverage_keys)
    VALUES(0,$1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      definition,
      source,
      configuration,
      meaning,
      digest(definition).toString('hex'),
      JSON.stringify(['object', [['catalogueCoverage', ['value', true]]]]),
      JSON.stringify(dependencyKeys),
      keys,
    ],
  );
  await db.admin.query(
    'INSERT INTO search.public_filter_target(partition_no,physical_target,incarnation) VALUES(0,$1,$2)',
    [target, incarnation],
  );
  await db.admin.query(
    `INSERT INTO search.generation_publication
    (job,physical_target,consumer,prefix,generation,family,native_incarnation,kinds,source_home,binding,activated_at)
    VALUES($1,$2,$3,'retention-',1,'subjects',$4,'{}',0,$5,now()::text)`,
    [
      job,
      target,
      {
        readDefinition: definition,
        meaningDigest: meaning,
        physicalTarget: target,
        incarnation,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      incarnation,
      {
        readDefinition: definition,
        source: { id: source, configuration, epoch: 1, partition: 0 },
        meaning: { digest: meaning },
      },
    ],
  );
  await db.admin.query('SELECT core.enable_subject_retention_v1()');
  return { f, resident, book, bootstrap, job, keys };
}
