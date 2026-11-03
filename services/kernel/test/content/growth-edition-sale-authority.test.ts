import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { readContentEditionMechanicalSaleAuthority } from '../../src/content/edition-sale.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  type GrowthReport,
} from '../support/growth.ts';
import {
  createSaleAuthorityGrowthFixture,
  reportProvisionedOrigins,
  SALE_AUTHORITY_GROWTH_SCALES,
  type SaleAuthorityAxis,
  type SaleAuthorityRead,
  type SaleAuthorityTrace,
} from './support/growth-edition-sale-authority-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const axes: readonly SaleAuthorityAxis[] = [
  'edition-publication-receipts',
  'source-revision-subjects',
  'publisher-consent-grants',
];
const reads: readonly SaleAuthorityRead[] = ['mechanical', 'caller'];

function reportRelations(report: GrowthReport): string[] {
  return [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
}

function assertReadTrace(
  trace: SaleAuthorityTrace,
  options: {
    readonly publisherId: string;
    readonly publisherClientId: string;
    readonly editionId: string;
    readonly postId: string;
  },
): void {
  expect(trace.deadline - trace.startedAt).toBe(1000);
  expect(trace.consentReads.length).toBeGreaterThan(0);
  expect(trace.consentReads.length).toBeLessThanOrEqual(40);
  expect(trace.consentReads.every((read) => read.actorAccountId === options.publisherId)).toBe(true);
  expect(trace.consentReads.every((read) => read.clientId === options.publisherClientId)).toBe(true);
  expect(trace.accessChecks.length).toBeGreaterThan(0);
  expect(trace.accessChecks.length).toBeLessThanOrEqual(40);
  expect(trace.acquired).toBeGreaterThan(0);
  expect(trace.acquired).toBe(trace.released);
  expect(trace.openAtReturn).toBe(0);
  expect(trace.maxConcurrent).toBeLessThanOrEqual(1);

  const seller = trace.accessChecks.filter(
    (check) => check.actorAccountId === options.publisherId && check.action === 'edition:sell',
  );
  const sourceAuthor = trace.accessChecks.filter(
    (check) => check.actorAccountId === options.publisherId && check.action === 'post:revise',
  );
  expect(seller.length).toBeGreaterThanOrEqual(2);
  expect(seller.every((check) => check.resourceId === options.editionId)).toBe(true);
  expect(sourceAuthor.length).toBeGreaterThanOrEqual(2);
  expect(sourceAuthor.every((check) => check.resourceId === options.postId)).toBe(true);
  const liveTime = trace.accessChecks[0]!.time;
  expect(trace.accessChecks.every((check) => check.time === liveTime)).toBe(true);
}

function assertMeasuredReport(report: GrowthReport): void {
  expect(report.samples.map((sample) => sample.scale)).toEqual([...SALE_AUTHORITY_GROWTH_SCALES]);
  expect(report.samples.every((sample) => sample.repetitions.length === 1)).toBe(true);
  expect(
    report.samples.every(
      ({ cost }) =>
        cost.statements > 0 &&
        cost.rows > 0 &&
        Number.isFinite(cost.blocks) &&
        Number.isFinite(cost.sharedHit) &&
        Number.isFinite(cost.sharedRead),
    ),
  ).toBe(true);
  const relations = reportRelations(report);
  expect(relations.length).toBeGreaterThan(0);
  assertGrowthAccessPaths(report.name, report.samples, relations);
  console.info(
    `EDITION_SALE_AUTHORITY_GROWTH ${JSON.stringify({
      name: report.name,
      samples: report.samples.map((sample) => ({
        scale: sample.scale,
        cost: sample.cost,
        relationSizes: sample.relationSizes,
        statements: sample.statementRepetitions,
        occurrences: sample.occurrenceRepetitions,
      })),
    })}`,
  );
}

test('native Edition sale authority reads stay indexed across independent publisher, source and publication growth', async () => {
  const fixture = await createSaleAuthorityGrowthFixture(databaseUrl!);
  try {
    await reportProvisionedOrigins(fixture);
    expect(createHash('sha256').update(fixture.provenance.revision.body).digest('hex')).toBe(
      fixture.authority.source.sha256,
    );
    expect(fixture.provenance.revision.subject_ids).toContain(fixture.targetSubjectId);
    expect(fixture.provenance.edition.revision_id).toBe(fixture.revisionId);
    expect(fixture.provenance.publication.operation_id).not.toBe(fixture.editionId);

    const activeMechanical = await fixture.read('mechanical');
    expect(activeMechanical.value).toEqual(fixture.authority);
    assertReadTrace(activeMechanical.trace, {
      publisherId: fixture.author.accountId,
      publisherClientId: fixture.author.clientId,
      editionId: fixture.editionId,
      postId: fixture.postId,
    });
    const activeCaller = await fixture.read('caller', fixture.author);
    expect(activeCaller.value).toEqual(fixture.authority);
    assertReadTrace(activeCaller.trace, {
      publisherId: fixture.author.accountId,
      publisherClientId: fixture.author.clientId,
      editionId: fixture.editionId,
      postId: fixture.postId,
    });
    expect((await fixture.read('caller', fixture.buyer)).value).toBeNull();
    expect((await fixture.read('mechanical')).value).toEqual(fixture.authority);

    for (const axis of axes) {
      for (const variant of reads) {
        const read = async () => {
          const result = await fixture.read(variant, fixture.author);
          expect(result.value).toEqual(fixture.authority);
          assertReadTrace(result.trace, {
            publisherId: fixture.author.accountId,
            publisherClientId: fixture.author.clientId,
            editionId: fixture.editionId,
            postId: fixture.postId,
          });
          return result.value;
        };
        const report = await checkGrowth(fixture.app, {
          name: `content.edition.sale-authority.${variant}.${axis}`,
          scales: SALE_AUTHORITY_GROWTH_SCALES,
          rule: 'series',
          repetitions: 1,
          warmups: 1,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          grow: (_db, scale, previous) => fixture.grow(axis, fixture.app, scale, previous),
          operation: read,
          warmup: read,
        });
        assertMeasuredReport(report);
      }
    }

    const unchanged = await fixture.native.database.pool.query<{
      revision_id: string;
      body_sha256: Buffer;
      subject_ids: string[];
      state: string;
    }>(
      `SELECT e.revision_id::text,r.body_sha256,r.subject_ids::text[],e.state
         FROM content.edition e JOIN content.revision r
           ON r.route=e.route AND r.post_id=e.post_id AND r.revision_id=e.revision_id
        WHERE e.route=$1 AND e.edition_id=$2`,
      [fixture.route, fixture.editionId],
    );
    expect(unchanged.rows).toEqual([
      {
        revision_id: fixture.revisionId,
        body_sha256: fixture.provenance.revision.body_sha256,
        subject_ids: fixture.provenance.revision.subject_ids,
        state: 'published',
      },
    ]);

    await expect(
      readContentEditionMechanicalSaleAuthority(
        { pool: fixture.app.pool, access: fixture.native.access },
        fixture.editionId,
        { deadline: Date.now() - 1 },
      ),
    ).rejects.toBeInstanceOf(AccessUnavailableError);

    const grant = fixture.provenance.roleGrant;
    const revoked = await fixture.nativeRequest<{ grant: Record<string, unknown> }>(
      '/v1/roleGrants:revoke',
      'POST',
      fixture.governanceBearer,
      {
        resource: { route: grant.route, id: grant.resource_id },
        subject: { kind: 'account', id: grant.subject_id },
        role: grant.grant_role,
        valid: grant.valid,
      },
      200,
    );
    expect(revoked.body.grant).toBeTruthy();
    await expect(fixture.read('mechanical')).rejects.toBeInstanceOf(AccessUnavailableError);

    const consentEnvironment = ['KERNEL_AUTH_CONSENT_URL', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'] as const;
    const priorEnvironment = new Map(consentEnvironment.map((name) => [name, process.env[name]]));
    for (const name of consentEnvironment) delete process.env[name];
    try {
      await expect(
        readContentEditionMechanicalSaleAuthority(
          { pool: fixture.native.database.pool, access: fixture.native.access },
          fixture.editionId,
          { deadline: Date.now() + 1000 },
        ),
      ).rejects.toBeInstanceOf(AccessUnavailableError);
    } finally {
      for (const [name, value] of priorEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    await fixture.nativeRequest(
      `/v1/posts/${fixture.postId}`,
      'DELETE',
      fixture.native.actors.author.bearer,
      undefined,
      200,
    );
    expect((await fixture.read('mechanical')).value).toBeNull();
  } finally {
    await fixture.close();
  }
});
