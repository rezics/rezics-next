import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { replyReportAuthorityDatabase } from './reply-report-authority-fixture.ts';
import { CATEGORY_VERSION, type PublicReportInput } from '../src/modules/public-report/contract.ts';
import { GLOBAL_CONTEXT } from '../src/modules/governance/schema.ts';

let database: Awaited<ReturnType<typeof replyReportAuthorityDatabase>>;
beforeAll(async () => {
  database = await replyReportAuthorityDatabase();
}, 60_000);
afterAll(async () => {
  await database?.stop();
});

test('readable exact public and private Realm reply bodies can enter authenticated report intake', async () => {
  const h = await database.fixture();
  try {
    const observed = [];
    for (const privateRealm of [false, true]) {
      const reply = await h.createReply({ private: privateRealm });
      expect(await h.read(reply)).toMatchObject({
        reply: reply.reply,
        revisionId: reply.revisionId,
        revisionDigest: reply.revisionDigest,
        originRealm: reply.realm,
      });
      const body = h.reportBody(reply);
      const response = await h.post('/v1/reports', body, h.reader, body.idempotencyKey);
      observed.push({ privateRealm, status: response.status, problem: response.body });
      if (response.status === 201) {
        const retained = (
          await h.accessPool.query(
            `SELECT c.context,c.disclosure,e.revision,
          e.revision_digest,e.provenance FROM access.governance_report r
          JOIN access.governance_case c ON c.id=r.case_id
          JOIN access.governance_evidence e ON e.report_id=r.id WHERE r.id=$1`,
            [response.body.reportId],
          )
        ).rows[0];
        expect(retained).toMatchObject({
          context: reply.realm,
          disclosure: 'private',
          revision: reply.revisionId,
          revision_digest: reply.revisionDigest,
          provenance: {
            author: h.author.actor,
            realm: reply.realm,
            root: h.work,
            rootRevision: h.rootRevision,
            variant: reply.variantId,
            disclosure: privateRealm ? 'private' : 'public',
          },
        });
        expect(h.workReadCalls).not.toContain(reply.reply);
        expect(
          (
            await h.accessPool.query('SELECT 1 FROM access.permission_grant WHERE scope_id=$1', [
              `work:read:${reply.reply}`,
            ])
          ).rowCount,
        ).toBe(0);
        expect(await h.post('/v1/reports', body, h.reader, body.idempotencyKey)).toMatchObject({
          status: 200,
          body: { reportId: response.body.reportId, replayed: true },
        });
      }
    }
    if (observed.some((row) => row.status !== 201))
      console.info('Reply reporting API/PostgreSQL counterexample', observed);
    expect(observed.map((row) => row.status)).toEqual([201, 201]);
  } finally {
    await h.stop();
  }
}, 120_000);

test('signed private public-report intake retains the server-resolved reply origin', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply({ private: true });
    expect(await h.read(reply)).toMatchObject({ revisionId: reply.revisionId });
    const response = await h.post(
      '/v1/public-reports',
      {
        profile: CATEGORY_VERSION,
        target: reply.reply,
        category: 'realm_rules',
        realm: reply.realm,
        actingSubject: h.reader.actor,
        statement: 'Review this exact private reply',
        contentLanguage: 'en',
      },
      h.reader,
      randomUUID(),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(
      (
        await h.accessPool.query(
          `SELECT c.context,c.disclosure,e.provenance
      FROM access.governance_report r JOIN access.governance_case c ON c.id=r.case_id
      JOIN access.governance_evidence e ON e.report_id=r.id WHERE r.id=$1`,
          [response.body.reportId],
        )
      ).rows[0],
    ).toMatchObject({
      context: reply.realm,
      disclosure: 'private',
      provenance: {
        realm: reply.realm,
        author: h.author.actor,
        variant: reply.variantId,
        disclosure: 'private',
      },
    });
    expect(h.scopeChecks).toContainEqual(['work:read']);
    h.deniedScopes.add('work:read');
    expect(
      (
        await h.post(
          '/v1/public-reports',
          {
            profile: CATEGORY_VERSION,
            target: reply.reply,
            category: 'realm_rules',
            realm: reply.realm,
            actingSubject: h.reader.actor,
            statement: 'No read consent',
            contentLanguage: 'en',
          },
          h.reader,
          randomUUID(),
        )
      ).status,
    ).toBe(404);
  } finally {
    await h.stop();
  }
}, 120_000);

test('anonymous report intake admits only currently public exact reply evidence', async () => {
  const h = await database.fixture();
  try {
    const visible = await h.createReply();
    const hidden = await h.createReply({ private: true });
    const input = (target: string): PublicReportInput => ({
      profile: CATEGORY_VERSION,
      target,
      category: 'harassment',
      statement: 'Please review',
      contentLanguage: 'en',
    });
    const receipt = await h.post('/v1/public-reports', input(visible.reply), null);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(
      (
        await h.accessPool.query(
          `SELECT c.context,c.disclosure,e.revision,e.provenance
      FROM access.governance_report r JOIN access.governance_case c ON c.id=r.case_id
      JOIN access.governance_evidence e ON e.report_id=r.id WHERE r.id=$1`,
          [receipt.body.reportId],
        )
      ).rows[0],
    ).toMatchObject({
      context: GLOBAL_CONTEXT,
      disclosure: 'private',
      revision: visible.revisionId,
      provenance: { realm: visible.realm, disclosure: 'public' },
    });
    expect((await h.post('/v1/public-reports', input(hidden.reply), null)).status).toBe(404);
    await h.revokeApproval(visible);
    expect((await h.post('/v1/public-reports', input(visible.reply), null)).status).toBe(404);
    expect(
      h.graphQueries.some((query) => query.includes('SELECT ?r ?contentRevision ?realm WHERE')),
    ).toBe(false);
  } finally {
    await h.stop();
  }
}, 120_000);

test('private reply reports refuse outsiders, spoofed actors and revoked membership or approval', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply({ private: true });
    for (const [person, actor] of [
      [h.outsider, h.outsider.actor],
      [h.reader, h.outsider.actor],
    ] as const) {
      const body = h.reportBody(reply, person, { actingSubject: actor });
      expect((await h.post('/v1/reports', body, person, body.idempotencyKey)).status).toBe(403);
      expect(
        (
          await h.post(
            '/v1/public-reports',
            {
              profile: CATEGORY_VERSION,
              target: reply.reply,
              category: 'realm_rules',
              realm: reply.realm,
              actingSubject: actor,
              statement: 'Outsider',
              contentLanguage: 'en',
            },
            person,
          )
        ).status,
      ).toBe(404);
    }
    await h.revokeMembership(h.reader, reply.realm);
    const body = h.reportBody(reply);
    expect((await h.post('/v1/reports', body, h.reader, body.idempotencyKey)).status).toBe(403);
    await h.revokeApproval(reply);
    const authorBody = h.reportBody(reply, h.author);
    expect(
      (await h.post('/v1/reports', authorBody, h.author, authorBody.idempotencyKey)).status,
    ).toBe(403);
    expect((await h.accessPool.query('SELECT 1 FROM access.governance_report')).rowCount).toBe(0);
  } finally {
    await h.stop();
  }
}, 120_000);

test('reply evidence pins the readable revision and rejects stale, mismatched and non-body references', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply(),
      other = await h.createReply();
    for (const evidence of [
      {
        owner: 'content',
        resource: reply.reply,
        component: 'body',
        revision: other.revisionId,
        locator: null,
      },
      {
        owner: 'content',
        resource: reply.reply,
        component: 'body',
        revision: reply.revisionId,
        locator: reply.variantId,
      },
      {
        owner: 'content',
        resource: reply.reply,
        component: 'title',
        revision: reply.revisionId,
        locator: null,
      },
    ]) {
      const body = h.reportBody(reply, h.reader, { evidence: [evidence] });
      expect((await h.post('/v1/reports', body, h.reader, body.idempotencyKey)).status).toBe(
        evidence.component === 'body' && evidence.locator === null ? 403 : 400,
      );
    }
    await h.editReply(reply);
    const stale = h.reportBody(reply);
    expect((await h.post('/v1/reports', stale, h.reader, stale.idempotencyKey)).status).toBe(403);
    expect(
      (
        await h.post(
          '/v1/public-reports',
          {
            profile: CATEGORY_VERSION,
            target: reply.reply,
            category: 'harassment',
            statement: 'Stale placement',
            contentLanguage: 'en',
          },
          null,
        )
      ).status,
    ).toBe(404);
    expect((await h.accessPool.query('SELECT 1 FROM access.governance_report')).rowCount).toBe(0);
  } finally {
    await h.stop();
  }
}, 120_000);

test('reply case jurisdiction and privacy come from the owner rather than caller context', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply({ private: true });
    const failures = [
      {
        context: h.publicRealm,
        authority: { kind: 'realm', scopeId: `governance:realm:${h.publicRealm}` },
      },
      {
        context: reply.realm,
        authority: { kind: 'resource_owner', scopeId: `governance:realm:${reply.realm}` },
      },
      {
        context: GLOBAL_CONTEXT,
        authority: { kind: 'platform', scopeId: `governance:realm:${reply.realm}` },
      },
      { disclosure: 'public_summary' },
      { disclosure: 'parties' },
    ];
    for (const overrides of failures) {
      const body = h.reportBody(reply, h.reader, overrides);
      expect((await h.post('/v1/reports', body, h.reader, body.idempotencyKey)).status).toBe(400);
    }
    const global = h.reportBody(reply, h.reader, {
      context: GLOBAL_CONTEXT,
      authority: { kind: 'platform', scopeId: 'governance:platform' },
    });
    const receipt = await h.post('/v1/reports', global, h.reader, global.idempotencyKey);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(
      (
        await h.accessPool.query(
          `SELECT c.context,c.disclosure,e.provenance FROM access.governance_report r
      JOIN access.governance_case c ON c.id=r.case_id JOIN access.governance_evidence e ON e.report_id=r.id WHERE r.id=$1`,
          [receipt.body.reportId],
        )
      ).rows[0],
    ).toMatchObject({
      context: GLOBAL_CONTEXT,
      disclosure: 'private',
      provenance: { realm: reply.realm, disclosure: 'private' },
    });
    expect(
      (
        await h.post('/v1/public-reports', {
          profile: CATEGORY_VERSION,
          target: reply.reply,
          category: 'realm_rules',
          realm: h.publicRealm,
          actingSubject: h.reader.actor,
          statement: 'Foreign Realm',
          contentLanguage: 'en',
        })
      ).status,
    ).toBe(400);
  } finally {
    await h.stop();
  }
}, 120_000);

test('reply authority and exact byte health failures stay unavailable and cannot create a report', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply({ private: true });
    const proof = h.access.realmReadProof;
    h.access.realmReadProof = async () => {
      throw new Error('Authority owner unavailable');
    };
    const body = h.reportBody(reply);
    expect((await h.post('/v1/reports', body, h.reader, body.idempotencyKey)).status).toBe(503);
    expect(
      (
        await h.post('/v1/public-reports', {
          profile: CATEGORY_VERSION,
          target: reply.reply,
          category: 'realm_rules',
          realm: reply.realm,
          actingSubject: h.reader.actor,
          statement: 'Authority outage',
          contentLanguage: 'en',
        })
      ).status,
    ).toBe(503);
    h.access.realmReadProof = proof;
    await h.contentPool.query('ALTER TABLE content.revision DISABLE TRIGGER revision_immutable');
    await h.contentPool.query('UPDATE content.revision SET byte_digest=$2 WHERE id=$1', [
      reply.revisionId,
      '0'.repeat(64),
    ]);
    await h.contentPool.query('ALTER TABLE content.revision ENABLE TRIGGER revision_immutable');
    const damaged = h.reportBody(reply);
    expect((await h.post('/v1/reports', damaged, h.reader, damaged.idempotencyKey)).status).toBe(
      503,
    );
    expect((await h.accessPool.query('SELECT 1 FROM access.governance_report')).rowCount).toBe(0);
  } finally {
    await h.stop();
  }
}, 120_000);

test('Realm restriction and reversal fence the reported exact reply variant and preserve retained evidence', async () => {
  const h = await database.fixture();
  try {
    const reply = await h.createReply({ private: true });
    const body = h.reportBody(reply);
    const report = await h.post('/v1/reports', body, h.reader, body.idempotencyKey);
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const rules = h.deps.governance!.rules!;
    const rule = await rules.publish(h.moderator.principal, {
      ref: `urn:reply-report:rule:${randomUUID()}`,
      scopeId: `governance:realm:${reply.realm}`,
      actingSubject: h.moderator.actor,
      expectedRevision: null,
      document: { rule: 'No abuse' },
      idempotencyKey: randomUUID(),
    });
    const input = {
      profile: 'moderation-decision-v1',
      caseId: report.body.caseId,
      expectedGeneration: '0',
      actingSubject: h.moderator.actor,
      outcome: 'restrict',
      targets: [
        {
          owner: 'content',
          resource: reply.reply,
          component: 'body',
          locator: null,
          scopeKind: 'exact_revision',
          revision: reply.revisionId,
          expectedHead: reply.revisionId,
          effect: 'disclosure',
        },
      ],
      rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
      evidenceDigest: report.body.evidenceDigest,
      reversesDecisionId: null,
      answersStepId: null,
      rationale: 'Abusive reply',
      disclosure: 'private',
      idempotencyKey: randomUUID(),
      reasons: {
        facts: 'Abusive reply',
        scope: 'Exact Realm reply revision',
        duration: 'Until reconsidered',
        automation: false,
        contentLanguage: 'en',
        appealRoute: '/v1/public-reports/{caseId}/correspondence',
      },
    };
    let restriction = await h.post(
      '/v1/moderation/decisions',
      input,
      h.moderator,
      input.idempotencyKey,
    );
    if (restriction.status === 202)
      restriction = await h.post(
        '/v1/moderation/decisions',
        input,
        h.moderator,
        input.idempotencyKey,
      );
    expect(restriction.status, JSON.stringify(restriction.body)).toBe(200);
    expect(await h.read(reply)).toBeNull();
    const reversal = {
      ...input,
      expectedGeneration: restriction.body.caseGeneration,
      outcome: 'reverse',
      reversesDecisionId: restriction.body.decisionId,
      idempotencyKey: randomUUID(),
    };
    let restored = await h.post(
      '/v1/moderation/decisions',
      reversal,
      h.moderator,
      reversal.idempotencyKey,
    );
    if (restored.status === 202)
      restored = await h.post(
        '/v1/moderation/decisions',
        reversal,
        h.moderator,
        reversal.idempotencyKey,
      );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await h.read(reply)).toMatchObject({
      revisionId: reply.revisionId,
      variantId: reply.variantId,
    });
    const effects = (
      await h.contentPool.query(
        'SELECT variant_id,expected_head FROM content.moderation_effect WHERE resource_id=$1',
        [reply.reply],
      )
    ).rows;
    expect(effects).toHaveLength(2);
    expect(
      effects.every(
        (row) => row.variant_id === reply.variantId && row.expected_head === reply.revisionId,
      ),
    ).toBe(true);
    expect(
      (
        await h.accessPool.query(
          'SELECT revision,revision_digest FROM access.governance_evidence WHERE report_id=$1',
          [report.body.reportId],
        )
      ).rows,
    ).toEqual([{ revision: reply.revisionId, revision_digest: reply.revisionDigest }]);
  } finally {
    await h.stop();
  }
}, 120_000);
