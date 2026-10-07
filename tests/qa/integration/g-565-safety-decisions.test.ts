import { getTableConfig } from 'drizzle-orm/pg-core';
import { governanceTables } from '../../../services/main/src/modules/governance/schema.ts';
import { mediaTables } from '../../../services/main/src/modules/media/typed-schema.ts';
import { expect, test } from 'bun:test';
import { RightsCounterNotices } from '../../../services/main/src/modules/rights/counter-notice-worker.ts';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { requirePlatformParticipation } from '../../../services/main/src/modules/safety-queue/participation.ts';
import { SAFETY_QUEUE_COST } from '../../../services/main/src/modules/safety-queue/store.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import {
  GovernanceStore,
  GovernanceUnavailable,
  GOVERNANCE_OPERATION_COST,
  type DecisionInput,
  type DecisionResult,
} from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import {
  ownerEvidenceCapture,
  ownerTargetHeads,
} from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import {
  contentDraftIntentDigest,
  type SaveDraftCommand,
} from '../../../services/content/src/core.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { startMediaStack, png, sha } from './media-support.ts';

type Receipt = { caseId: string; reportId: string; credential: string; receivedAt: string };
const reasons = {
  facts: 'Staff verified the retained report and exact revision.',
  scope: 'The declared targets only.',
  duration: 'Until reconsidered by staff.',
  automation: false,
  appealRoute: '/v1/public-reports/{caseId}/correspondence' as const,
  contentLanguage: 'sw-KE',
};

test('G-565: platform queue, exclusive claims, immutable reasons, resumable owner effects, appeals and legal windows', async () => {
  const stack = await startMediaStack('g-565');
  try {
    for (const table of governanceTables) {
      const config = getTableConfig(table);
      const columns = await stack.accessPool.query<{ column_name: string }>(
        `SELECT column_name
        FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [config.schema, config.name],
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
    }
    for (const table of Object.values(mediaTables)) {
      const config = getTableConfig(table);
      const columns = await stack.contentPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [config.schema, config.name],
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
    }
    const staff = await stack.member('staff');
    const other = await stack.member('other-staff');
    const author = await stack.member('affected-author');
    const former = await stack.member('former-representative');
    const expired = await stack.member('expired-representative');
    for (const [member, active, validUntil] of [
      [former, false, new Date(Date.now() + 3600_000)],
      [expired, true, new Date(Date.now() - 3600_000)],
    ] as const)
      await stack.accessPool.query(
        `INSERT INTO access.representation
      (id,principal_id,subject_id,action,active,valid_until) VALUES ($1,$2,$3,'governance.appeal',$4,$5)`,
        [randomUUID(), member.principalId, author.actor, active, validUntil],
      );
    for (const member of [staff, other])
      for (const action of [
        'governance.moderate',
        'governance.rights.decide',
        'governance.safety.evidence',
        'governance.rule.publish',
      ])
        await member.grant('governance:platform', action);
    const tokenMap = new Map(
      [staff, other, author, former, expired].map((member) => [member.token, member.principal]),
    );
    let clock = new Date();
    let interruptOrdinal: number | null = null;
    let loseAfterOrdinal: number | null = null;
    const applied = new Map<string, number>();
    const effects = ownerModerationEffects(new ContentModeration(stack.contentPool), stack.env, {
      pool: stack.contentPool,
      core: stack.content,
    });
    const capture = ownerEvidenceCapture({
      content: {
        core: stack.content,
        canRead: async (_principal, _actor, ids) => {
          const rows = await stack.contentPool.query<{ id: string }>(
            `SELECT r.id FROM content.revision r
        JOIN content.variant v ON v.id = r.variant_id JOIN media.asset a ON v.id = a.variant_id
        JOIN media.asset_state s ON s.id = a.state_head WHERE r.id = ANY($1::uuid[])
          AND s.disclosure = 'public' AND s.lifecycle = 'active' AND s.moderation = 'none'`,
            [ids],
          );
          return new Set(rows.rows.map((row) => row.id));
        },
      },
    });
    const rules = new GovernanceRules(stack.accessPool);
    // Count real Access queries, including authority and recovery fences. Page
    // cost must stay constant as queue size grows; effect cost stays per target.
    let statements = 0;
    const transactions: number[] = [];
    const measuredPool = new Proxy(stack.accessPool, {
      get(pool, property) {
        if (property === 'connect')
          return async () => {
            const client = await pool.connect();
            let count = 0;
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return (...args: unknown[]) => {
                    statements++;
                    count++;
                    return Reflect.apply(connection.query, connection, args);
                  };
                if (key === 'release')
                  return () => {
                    transactions.push(count);
                    connection.release();
                  };
                const value = Reflect.get(connection, key);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(pool, property);
        return typeof value === 'function' ? value.bind(pool) : value;
      },
    }) as Pool;
    const governance = new GovernanceStore(
      measuredPool,
      capture,
      ownerTargetHeads({ graph: stack.env, content: stack.contentPool }),
      rules,
      {
        plan: effects.plan,
        apply: async (...args) => {
          const key = `${args[0]}:${args[1]}`;
          if (args[1] === interruptOrdinal) {
            interruptOrdinal = null;
            throw new GovernanceUnavailable('injected owner interruption');
          }
          applied.set(key, (applied.get(key) ?? 0) + 1);
          const result = await effects.apply(...args);
          if (args[1] === loseAfterOrdinal) {
            loseAfterOrdinal = null;
            throw new GovernanceUnavailable('lost owner acknowledgement');
          }
          return result;
        },
      },
      undefined,
      () => clock,
    );
    const deps: MainWorkDependencies = {
      environment: stack.env,
      access: stack.access,
      content: stack.content,
      contentAuthoring: stack.content,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      governance: { store: governance, rules },
      realmReplies: new RealmReplyStore(
        new RealmReplyContentStore(stack.contentPool),
        stack.content,
        stack.access,
        stack.env,
      ),
      account: {
        verify: async (request) => {
          const principal = tokenMap.get(
            request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
          );
          if (!principal) throw new AccountAssertionDenied('unknown test bearer');
          return principal;
        },
      },
    };
    deps.publicReports = new PublicReports(
      stack.accessPool,
      publicReportOwners(deps, stack.contentPool, stack.content),
    );
    const app = createMainApp(stack.fuseki, deps);
    const call = (
      method: string,
      path: string,
      body?: unknown,
      token?: string,
      key = randomUUID(),
      credential?: string,
    ) =>
      app.handle(
        new Request(`http://main.test${path}`, {
          method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(credential ? { 'x-rezics-case-credential': credential } : {}),
            ...(method === 'POST' ? { 'idempotency-key': key } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const json = async <T>(response: Response, status: number): Promise<T> => {
      if (response.status !== status)
        throw new Error(`expected ${status}, got ${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const original = async (id: string) =>
      (
        await stack.contentPool.query<{ clearance: string }>(
          'SELECT media.delivery_clearance(p) AS clearance FROM media.representation p WHERE id = $1',
          [id],
        )
      ).rows[0];
    const report = async (asset: string, category = 'harassment', extra = {}, key = randomUUID()) =>
      json<Receipt>(
        await call(
          'POST',
          '/v1/public-reports',
          {
            profile: 'public-report-v1',
            target: `https://rezics.com/id/${asset}`,
            category,
            statement: 'Private report in Kiswahili',
            contentLanguage: 'sw-KE',
            ...extra,
          },
          undefined,
          key,
        ),
        201,
      );
    const claim = (receipt: Receipt, member = staff) => {
      const key = randomUUID();
      return call(
        'POST',
        `/v1/safety-cases/${receipt.caseId}/claim`,
        { actingSubject: member.actor, idempotencyKey: key },
        member.token,
        key,
      );
    };
    const asset = await author.upload(png(20, 20));
    const first = await report(asset.asset);
    expect(
      (
        await call(
          'GET',
          `/v1/safety-cases?actingSubject=${encodeURIComponent(author.actor)}`,
          undefined,
          author.token,
        )
      ).status,
    ).toBe(403);
    const queue = await json<{ items: Array<{ caseId: string }>; nextCursor: string | null }>(
      await call(
        'GET',
        `/v1/safety-cases?actingSubject=${encodeURIComponent(staff.actor)}&urgent=false&category=harassment&contentLanguage=sw-KE`,
        undefined,
        staff.token,
      ),
      200,
    );
    expect(queue.items.some((item) => item.caseId === first.caseId)).toBe(true);
    // A complete keyset traversal crosses every response bound.
    for (let index = 0; index < 55; index++) {
      const caseId = randomUUID();
      await stack.accessPool.query(
        `INSERT INTO access.governance_case (id,kind,authority_kind,authority_scope_id,
        context,target_owner,target_resource,target_component,disclosure)
        VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,'title','private')`,
        [caseId, `https://rezics.com/id/${randomUUID()}`],
      );
      await stack.accessPool.query(
        `INSERT INTO access.governance_report (id,case_id,idempotency_key,request_digest,
        reason_code,evidence_count,evidence_digest,content_language) VALUES ($1,$2,$3,$4,'spam_or_manipulation',1,$4,'ar')`,
        [randomUUID(), caseId, randomUUID(), sha(caseId)],
      );
    }
    const traversed = new Set<string>();
    let cursor: string | null = null;
    do {
      const before = statements;
      const page = await json<typeof queue>(
        await call(
          'GET',
          `/v1/safety-cases?actingSubject=${encodeURIComponent(staff.actor)}&category=spam_or_manipulation&limit=7` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
          undefined,
          staff.token,
        ),
        200,
      );
      expect(statements - before).toBeLessThanOrEqual(SAFETY_QUEUE_COST.readStatements);
      for (const item of page.items) {
        expect(traversed.has(item.caseId)).toBe(false);
        traversed.add(item.caseId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(traversed.size).toBe(55);
    const claimAsset = await author.upload(png(19, 19));
    const recoverable = await report(claimAsset.asset);
    await json(await claim(recoverable), 200);
    clock = new Date(clock.getTime() + 31 * 60_000);
    await json(await claim(recoverable, other), 200);
    await stack.accessPool.query(
      `UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform' AND action = 'governance.moderate'`,
      [other.actor],
    );
    await json(await claim(recoverable), 200);
    await stack.accessPool.query(
      `UPDATE access.permission_grant SET active = true
      WHERE recipient_subject = $1 AND scope_id = 'governance:platform' AND action = 'governance.moderate'`,
      [other.actor],
    );
    clock = new Date();
    const races = await Promise.all([claim(first), claim(first, other)]);
    expect(races.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = races[0]!.status === 200 ? staff : other;
    const ruleKey = randomUUID();
    const rule = await json<{ ref: string; revision: string; digest: string }>(
      await call(
        'POST',
        '/v1/governance/rules',
        {
          profile: 'governance-rule-v1',
          ref: `urn:g565:rule:${randomUUID()}`,
          scopeId: 'governance:platform',
          actingSubject: staff.actor,
          expectedRevision: null,
          document: { rule: 'Reviewed platform rule' },
          idempotencyKey: ruleKey,
        },
        staff.token,
        ruleKey,
      ),
      201,
    );
    const readCase = async (receipt: Receipt, member = staff) =>
      json<{
        generation: string;
        reports: Array<{ evidenceDigest: string }>;
        decision: DecisionResult | null;
      }>(
        await call(
          'GET',
          `/v1/safety-cases/${receipt.caseId}?actingSubject=${encodeURIComponent(member.actor)}`,
          undefined,
          member.token,
        ),
        200,
      );
    const input = async (
      receipt: Receipt,
      targets: DecisionInput['targets'],
      member = staff,
      outcome: DecisionInput['outcome'] = 'restrict',
      reversesDecisionId: string | null = null,
    ): Promise<DecisionInput> => {
      await json(await claim(receipt, member), 200);
      const view = await readCase(receipt, member);
      return {
        caseId: receipt.caseId,
        expectedGeneration: view.generation,
        actingSubject: member.actor,
        outcome,
        targets,
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
        evidenceDigest: view.reports[0]!.evidenceDigest,
        reversesDecisionId,
        answersStepId: null,
        rationale: 'Retained findings',
        disclosure: 'parties',
        reasons,
        idempotencyKey: randomUUID(),
      };
    };
    const target = (
      image: typeof asset,
      effect: DecisionInput['targets'][number]['effect'] = 'disclosure',
    ) => ({
      owner: 'content' as const,
      resource: `https://rezics.com/id/${image.asset}`,
      component: 'body' as const,
      locator: null,
      scopeKind: 'exact_revision' as const,
      revision: image.revision,
      expectedHead: image.revision,
      effect,
    });
    const decide = (body: DecisionInput, member = staff) =>
      call(
        'POST',
        `/v1/safety-cases/${body.caseId}/decisions`,
        body,
        member.token,
        body.idempotencyKey,
      );
    const decisionInput = await input(first, [target(asset)], winner);
    decisionInput.disclosure = 'private';
    const accepted = await json<DecisionResult>(await decide(decisionInput, winner), 202);
    expect(accepted.operation.status).toBe('accepted');
    expect(accepted.enforcement).toEqual([]);
    expect(
      (
        await stack.accessPool.query(
          'SELECT id FROM access.outbox WHERE moderation_decision_id = $1',
          [accepted.decisionId],
        )
      ).rowCount,
    ).toBe(0);
    transactions.length = 0;
    const completed = await json<DecisionResult>(await decide(decisionInput, winner), 200);
    expect(Math.max(...transactions)).toBeLessThanOrEqual(
      GOVERNANCE_OPERATION_COST.accessStatementsPerTransaction,
    );
    expect(completed.operation.status).toBe('completed');
    expect(completed.operation.items[0]!.receipt).toBeTruthy();
    expect(
      (
        await stack.accessPool.query(
          'SELECT id FROM access.outbox WHERE moderation_decision_id = $1',
          [completed.decisionId],
        )
      ).rowCount,
    ).toBe(1);
    expect((await stack.store.readAsset(asset.asset))!.moderation).toBe('suppressed');
    const reassignedDecision = await input(recoverable, [target(claimAsset)]);
    expect(
      (await decide({ ...reassignedDecision, actingSubject: other.actor }, other)).status,
    ).toBe(403);
    await json(await decide(reassignedDecision), 202);
    const decidedByReplacement = await json<DecisionResult>(await decide(reassignedDecision), 200);
    expect(decidedByReplacement.operation.status).toBe('completed');
    expect((await stack.store.readAsset(claimAsset.asset))!.moderation).toBe('suppressed');

    await json<DecisionResult>(await decide(decisionInput, winner), 200);
    expect(applied.get(`governance-moderation:${completed.decisionId}:1`)).toBe(1);
    const notices = await json<{
      items: Array<{ caseId: string; credential: string; reasons: typeof reasons }>;
    }>(await call('GET', '/v1/safety-notices', undefined, author.token), 200);
    const notice = notices.items.find((item) => item.caseId === first.caseId)!;
    expect(notice.reasons.facts).toBe(reasons.facts);
    for (const member of [former, expired]) {
      const privateNotices = await json<typeof notices>(
        await call('GET', '/v1/safety-notices', undefined, member.token),
        200,
      );
      expect(privateNotices.items.some((item) => item.caseId === first.caseId)).toBe(false);
    }
    const reporterStatus = await json<{ statementOfReasons: unknown }>(
      await call(
        'GET',
        `/v1/public-reports/${first.caseId}`,
        undefined,
        undefined,
        undefined,
        first.credential,
      ),
      200,
    );
    expect(reporterStatus.statementOfReasons).toBeNull();
    const partyStatus = await json<{
      statementOfReasons: typeof reasons;
      operation: DecisionResult['operation'];
    }>(
      await call(
        'GET',
        `/v1/public-reports/${first.caseId}`,
        undefined,
        undefined,
        undefined,
        notice.credential,
      ),
      200,
    );
    expect(partyStatus.statementOfReasons.automation).toBe(false);
    expect(partyStatus.operation.status).toBe('completed');
    expect(
      (await call('GET', '/v1/safety-notices', undefined, other.token)).headers.get(
        'cache-control',
      ),
    ).toBe('no-store');
    await json(
      await call(
        'POST',
        `/v1/public-reports/${first.caseId}/correspondence`,
        { kind: 'appeal', statement: 'Please reconsider', contentLanguage: 'sw-KE' },
        undefined,
        randomUUID(),
        notice.credential,
      ),
      200,
    );
    const appealQueue = await json<typeof queue>(
      await call(
        'GET',
        `/v1/safety-cases?actingSubject=${encodeURIComponent(winner.actor)}&category=harassment`,
        undefined,
        winner.token,
      ),
      200,
    );
    expect(appealQueue.items.some((item) => item.caseId === first.caseId)).toBe(true);
    const reversal = await input(first, [target(asset)], winner, 'reverse', completed.decisionId);
    await json(await decide(reversal, winner), 202);
    const reversed = await json<DecisionResult>(await decide(reversal, winner), 200);
    expect(reversed.decisionId).not.toBe(completed.decisionId);
    expect((await stack.store.readAsset(asset.asset))!.moderation).toBe('none');
    expect((await original(asset.representation))!.clearance).toBe('cleared');
    await expect(
      stack.accessPool.query(
        'UPDATE access.moderation_decision SET statement_of_reasons = NULL WHERE id = $1',
        [completed.decisionId],
      ),
    ).rejects.toThrow();

    // Two independently owned media targets in one retained evidence set.
    const multiAsset = await author.upload(png(21, 21));
    const secondAsset = await author.upload(png(25, 25));
    const multi = await report(multiAsset.asset);
    await json(await claim(multi), 200);
    const reportKey = randomUUID();
    await json(
      await call(
        'POST',
        '/v1/reports',
        {
          profile: 'content-report-v1',
          actingSubject: staff.actor,
          authority: { kind: 'platform', scopeId: 'governance:platform' },
          context: 'urn:rezics:context:global',
          target: {
            owner: 'content',
            resource: `https://rezics.com/id/${multiAsset.asset}`,
            component: 'body',
          },
          disclosure: 'private',
          reasonCode: 'harassment',
          statement: 'Both originals were reviewed',
          evidence: [multiAsset, secondAsset].map((image) => ({
            owner: 'content',
            resource: `https://rezics.com/id/${image.asset}`,
            component: 'body',
            revision: image.revision,
            locator: null,
          })),
          idempotencyKey: reportKey,
        },
        staff.token,
        reportKey,
      ),
      201,
    );
    const multiInput = await input(multi, [target(multiAsset), target(secondAsset)]);
    await json(await decide(multiInput), 202);
    interruptOrdinal = 2;
    const partial = await json<DecisionResult>(await decide(multiInput), 202);
    expect(partial.operation.status).toBe('partial');
    expect(partial.operation.items.map((item) => item.state)).toEqual(['confirmed', 'uncertain']);
    const resumed = await json<DecisionResult>(await decide(multiInput), 200);
    expect(resumed.operation.items.map((item) => item.state)).toEqual(['confirmed', 'confirmed']);
    expect(resumed.operation.items[0]!.receipt).toBe(partial.operation.items[0]!.receipt);
    expect(applied.get(`governance-moderation:${resumed.decisionId}:1`)).toBe(1);
    expect((await decide({ ...multiInput, rationale: 'Changed intent' })).status).toBe(409);

    const lostAsset = await author.upload(png(26, 26));
    const lostCase = await report(lostAsset.asset);
    await json(await claim(lostCase), 200);
    const lostInput = await input(lostCase, [target(lostAsset)]);
    const lostAccepted = await json<DecisionResult>(await decide(lostInput), 202);
    loseAfterOrdinal = 1;
    const uncertain = await json<DecisionResult>(await decide(lostInput), 202);
    expect(uncertain.operation.items[0]!.state).toBe('uncertain');
    const recovered = await json<DecisionResult>(await decide(lostInput), 200);
    expect(recovered.operation.status).toBe('completed');
    const ownerOperation = `governance-moderation:${lostAccepted.decisionId}:1`;
    expect(
      (
        await stack.contentPool.query(
          'SELECT operation_id FROM content.receipt WHERE operation_id = $1',
          [ownerOperation],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await stack.contentPool.query('SELECT id FROM media.asset_state WHERE operation_id = $1', [
          ownerOperation,
        ])
      ).rowCount,
    ).toBe(1);

    // Participation uses the reported asset's owner, rather than a staff-supplied principal.
    const sanctionAsset = await author.upload(png(22, 22));
    const sanctionCase = await report(sanctionAsset.asset);
    await json(await claim(sanctionCase), 200);
    const sanction = await input(sanctionCase, [
      {
        ...target(sanctionAsset, 'participation'),
        expiresAt: new Date(Date.now() + 5000).toISOString(),
      },
    ]);
    await json(await decide(sanction), 202);
    await json(await decide(sanction), 200);
    for (const member of [former, expired])
      await expect(
        requirePlatformParticipation(stack.accessPool, member.principalId),
      ).resolves.toBeUndefined();
    const privateNotices = await json<typeof notices>(
      await call('GET', '/v1/safety-notices', undefined, author.token),
      200,
    );
    const sanctionNotice = privateNotices.items.find(
      (item) => item.caseId === sanctionCase.caseId,
    )!;
    await json(
      await call(
        'POST',
        `/v1/public-reports/${sanctionCase.caseId}/correspondence`,
        { kind: 'appeal', statement: 'Sanctioned party can still appeal', contentLanguage: 'fa' },
        undefined,
        randomUUID(),
        sanctionNotice.credential,
      ),
      200,
    );
    const work = await stack.publicWork(staff.actor);
    const head = (
      await stack.fuseki.query(
        `SELECT ?head WHERE { GRAPH <urn:rezics:graph:current> { <${work.work}> <https://rezics.com/vocab/head> ?head } }`,
      )
    ).results!.bindings[0]!.head!.value;
    const reply = `https://rezics.com/id/${randomUUID()}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const command: SaveDraftCommand = {
      operationId: randomUUID(),
      variant: {
        id: variantId,
        resourceId: reply,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr',
      },
      expectedHead: null,
      model: 'member-reply-v1',
      sourceRevision: head,
      provenance: {},
      serializedJson: JSON.stringify({
        body: 'A reply',
        deleted: false,
        rootTarget: work.work,
        rootRevision: head,
      }),
    };
    command.provenance = {
      kind: 'admitted-original-contribution-v1',
      author: author.actor,
      admissionId: randomUUID(),
      authorityEpoch: '0',
      scope: `content:draft:${reply}`,
      expectedHead: null,
      rightsBasis: 'original-contribution',
      requestDigest: contentDraftIntentDigest(command, author.actor),
    };
    const saved = await stack.content.saveDraft(command);
    await author.grant(`reply:create:${work.work}`, 'reply.create');
    const replyBody = {
      profile: 'realm-reply-identity-v1',
      reply,
      variantId,
      revisionId: saved.revisionId,
      author: author.actor,
      rootTarget: work.work,
      rootRevision: head,
      parentReply: null,
      parentRevision: null,
      contextRevision: null,
    };
    expect((await call('POST', '/v1/realm-replies', replyBody, author.token)).status).toBe(403);
    await Bun.sleep(Math.max(0, Date.parse(sanction.targets[0]!.expiresAt!) - Date.now() + 100));
    await json(await call('POST', '/v1/realm-replies', replyBody, author.token), 201);

    // Copy closure includes original, existing uploads, and later activation.
    const bytes = png(23, 23);
    const copies = await Promise.all([
      author.upload(bytes),
      author.upload(bytes),
      author.upload(bytes),
    ]);
    const copyBasis = await stack.store.publicationBasis([copies[1]!.asset], author.actor);
    const copyUse = randomUUID();
    await stack.store.createPublicationUses(randomUUID(), author.actor, work.work, [
      { ...copyBasis[0]!, use: copyUse },
    ]);
    const nciiKey = randomUUID();
    const nciiExtra = {
      contactEmail: 'safe@example.test',
      ncii: {
        signature: 'Depicted person',
        depictedPersonOrAuthorized: true,
        goodFaithWithoutConsent: true,
        supportingInformation: 'Identified depiction',
      },
    };
    const ncii = await report(copies[0]!.asset, 'ncii', nciiExtra, nciiKey);
    clock = new Date(Date.parse(ncii.receivedAt) + 49 * 3600_000);
    const due = await json<{ items: Array<{ caseId: string; dueAt: string }> }>(
      await call(
        'GET',
        `/v1/safety-cases/due-steps?actingSubject=${encodeURIComponent(staff.actor)}`,
        undefined,
        staff.token,
      ),
      200,
    );
    const deadline = due.items.find((item) => item.caseId === ncii.caseId)!;
    expect(deadline.dueAt).toBe(
      new Date(Date.parse(ncii.receivedAt) + 48 * 3600_000).toISOString(),
    );
    const retriedIntake = await json<Receipt>(
      await call(
        'POST',
        '/v1/public-reports',
        {
          profile: 'public-report-v1',
          target: `https://rezics.com/id/${copies[0]!.asset}`,
          category: 'ncii',
          statement: 'Private report in Kiswahili',
          contentLanguage: 'sw-KE',
          ...nciiExtra,
        },
        undefined,
        nciiKey,
      ),
      200,
    );
    expect(retriedIntake.receivedAt).toBe(ncii.receivedAt);
    const dueRetry = await json<typeof due>(
      await call(
        'GET',
        `/v1/safety-cases/due-steps?actingSubject=${encodeURIComponent(staff.actor)}`,
        undefined,
        staff.token,
      ),
      200,
    );
    expect(dueRetry.items.find((item) => item.caseId === ncii.caseId)!.dueAt).toBe(deadline.dueAt);
    const specialist = (active: boolean) =>
      stack.accessPool.query(
        `UPDATE access.permission_grant SET active = $1 WHERE recipient_subject = $2
       AND scope_id = 'governance:platform' AND action = 'governance.safety.evidence'`,
        [active, staff.actor],
      );
    await specialist(false);
    expect((await claim(ncii)).status).toBe(403);
    const ordinaryQueue = await json<{ items: Array<{ urgent: boolean; restricted: boolean; target: unknown }> }>(
      await call(
        'GET',
        `/v1/safety-cases?actingSubject=${encodeURIComponent(staff.actor)}`,
        undefined,
        staff.token,
      ),
      200,
    );
    expect(ordinaryQueue.items.every((item) => !item.urgent || item.restricted && item.target === null)).toBe(true);
    const urgentQueue = await json<typeof ordinaryQueue>(
      await call(
        'GET',
        `/v1/safety-cases?actingSubject=${encodeURIComponent(staff.actor)}&urgent=true`,
        undefined,
        staff.token,
      ),
      200,
    );
    expect(urgentQueue.items.length).toBeGreaterThan(0);
    expect(urgentQueue.items.every((item) => item.urgent && item.restricted && item.target === null)).toBe(true);

    await specialist(true);
    const beforeClaim = statements;
    await json(await claim(ncii), 200);
    expect(statements - beforeClaim).toBeLessThanOrEqual(SAFETY_QUEUE_COST.claimStatements);
    const holdKey = randomUUID();
    await json(
      await call(
        'POST',
        `/v1/safety-cases/${ncii.caseId}/preservation-holds`,
        { actingSubject: staff.actor, reason: 'Urgent preservation', idempotencyKey: holdKey },
        staff.token,
        holdKey,
      ),
      200,
    );
    const beforeErasure = (await stack.store.readAsset(copies[0]!.asset))!;
    expect(
      (
        await call(
          'POST',
          `/v1/media/assets/${copies[0]!.asset}/state`,
          {
            profile: 'media-asset-state-v1',
            expectedState: beforeErasure.state,
            disclosure: 'public',
            lifecycle: 'erased',
            actingSubject: author.actor,
          },
          author.token,
        )
      ).status,
    ).toBe(403);
    expect((await stack.store.readAsset(copies[0]!.asset))!.lifecycle).toBe('active');
    expect(
      (
        await stack.accessPool.query(
          'SELECT hold_id FROM access.governance_erasure_postponement WHERE material_ref = $1',
          [`https://rezics.com/id/${copies[0]!.asset}`],
        )
      ).rowCount,
    ).toBe(1);
    const nciiInput = await input(ncii, [target(copies[0]!)]);
    await specialist(false);
    expect((await decide(nciiInput)).status).toBe(403);
    await specialist(true);
    const nciiAccepted = await json<DecisionResult>(await decide(nciiInput), 202);
    await specialist(false);
    expect((await decide(nciiInput)).status).toBe(403);
    const cancellationKey = randomUUID();
    expect(
      (
        await call(
          'POST',
          `/v1/safety-decisions/${nciiAccepted.decisionId}/cancellation`,
          { actingSubject: staff.actor, idempotencyKey: cancellationKey },
          staff.token,
          cancellationKey,
        )
      ).status,
    ).toBe(403);
    await specialist(true);
    transactions.length = 0;
    const nciiDone = await json<DecisionResult>(await decide(nciiInput), 200);
    expect(Math.max(...transactions)).toBeLessThanOrEqual(
      GOVERNANCE_OPERATION_COST.accessStatementsPerTransaction,
    );
    expect(nciiDone.operation.status).toBe('completed');
    for (const copy of copies)
      expect((await stack.store.readAsset(copy.asset))!.moderation).toBe('suppressed');
    const later = await author.upload(bytes);
    expect((await original(later.representation))!.clearance).toBe('rejected');
    expect(
      (
        await stack.contentPool.query(
          'SELECT digest FROM media.suppressed_digest WHERE digest = $1',
          [sha(bytes)],
        )
      ).rowCount,
    ).toBe(1);

    expect((await call('GET', `/v1/media/uses/${copyUse}`)).status).toBe(404);

    // A regular reversal cannot lift the digest. Staff must uphold a retained appeal.
    const nciiReversal = await input(
      ncii,
      [target(copies[0]!)],
      staff,
      'reverse',
      nciiDone.decisionId,
    );
    expect((await decide(nciiReversal)).status).toBe(400);
    const nciiNotices = await json<typeof notices>(
      await call('GET', '/v1/safety-notices', undefined, author.token),
      200,
    );
    const nciiNotice = nciiNotices.items.find((item) => item.caseId === ncii.caseId)!;
    const nciiAppeal = await json<{ stepId: string }>(
      await call(
        'POST',
        `/v1/public-reports/${ncii.caseId}/correspondence`,
        {
          kind: 'appeal',
          statement: 'The staff restriction is mistaken.',
          contentLanguage: 'sw-KE',
        },
        undefined,
        randomUUID(),
        nciiNotice.credential,
      ),
      200,
    );
    nciiReversal.answersStepId = nciiAppeal.stepId;
    await json(await decide(nciiReversal), 202);
    loseAfterOrdinal = 1;
    const lostLift = await json<DecisionResult>(await decide(nciiReversal), 202);
    expect(lostLift.operation.items[0]!.state).toBe('uncertain');
    const restoredCopies = await json<DecisionResult>(await decide(nciiReversal), 200);
    expect(restoredCopies.operation.status).toBe('completed');
    for (const copy of [...copies, later]) {
      expect((await stack.store.readAsset(copy.asset))!.moderation).toBe('none');
      expect((await original(copy.representation))!.clearance).toBe('cleared');
    }
    const copyDelivery = await call('GET', `/v1/media/uses/${copyUse}`);
    expect(copyDelivery.status).toBe(200);
    expect(sha(new Uint8Array(await copyDelivery.arrayBuffer()))).toBe(sha(bytes));
    const lift = (
      await stack.contentPool.query<{ suppression_id: string; operation_id: string }>(
        'SELECT suppression_id,operation_id FROM media.suppression_lift WHERE decision_id = $1',
        [restoredCopies.decisionId],
      )
    ).rows;
    expect(lift).toHaveLength(1);
    expect(
      (
        await stack.contentPool.query(
          `SELECT 1 FROM content.receipt r JOIN content.outbox o
      USING (operation_id,data_epoch,sequence) WHERE r.operation_id = $1`,
          [lift[0]!.operation_id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      stack.contentPool.query('DELETE FROM media.suppressed_digest WHERE id = $1', [
        lift[0]!.suppression_id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stack.contentPool.query(
        'UPDATE media.suppression_lift SET decision_id = $2 WHERE suppression_id = $1',
        [lift[0]!.suppression_id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stack.contentPool.query(
        `INSERT INTO media.suppression_lift
      (suppression_id,case_id,decision_id,operation_id) VALUES ($1,$2,$3,$4)`,
        [lift[0]!.suppression_id, ncii.caseId, restoredCopies.decisionId, lift[0]!.operation_id],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // The hold protects retained bytes after a successful appeal too.
    expect(
      (
        await call(
          'POST',
          `/v1/media/assets/${copies[0]!.asset}/state`,
          {
            profile: 'media-asset-state-v1',
            expectedState: (await stack.store.readAsset(copies[0]!.asset))!.state,
            disclosure: 'public',
            lifecycle: 'erased',
            actingSubject: author.actor,
          },
          author.token,
        )
      ).status,
    ).toBe(403);
    expect((await stack.store.readAsset(copies[0]!.asset))!.lifecycle).toBe('active');

    const reReported = await report(copies[0]!.asset, 'ncii', nciiExtra);
    await json(await claim(reReported), 200);
    const renewedRestriction = await input(reReported, [target(copies[0]!)]);
    await json(await decide(renewedRestriction), 202);
    const reSuppressed = await json<DecisionResult>(await decide(renewedRestriction), 200);
    expect(reSuppressed.operation.status).toBe('completed');
    expect(
      (
        await stack.contentPool.query('SELECT id FROM media.suppressed_digest WHERE digest = $1', [
          sha(bytes),
        ])
      ).rowCount,
    ).toBe(2);
    expect((await call('GET', `/v1/media/uses/${copyUse}`)).status).toBe(404);
    const afterReReport = await author.upload(bytes);
    expect((await original(afterReReport.representation))!.clearance).toBe('rejected');
    // Replaying the old upheld appeal does not lift the new suppression.
    await json(await decide(nciiReversal), 200);
    expect((await call('GET', `/v1/media/uses/${copyUse}`)).status).toBe(404);
    expect(
      (
        await stack.contentPool.query(
          'SELECT suppression_id FROM media.suppression_lift WHERE decision_id = $1',
          [restoredCopies.decisionId],
        )
      ).rowCount,
    ).toBe(1);

    clock = new Date();
    const copyrightAsset = await author.upload(png(24, 24));
    const copyright = await report(copyrightAsset.asset, 'copyright', {
      contactEmail: 'rights@example.test',
      copyright: {
        signature: 'Claimant',
        claimantName: 'Claimant',
        claimedWork: 'Original artwork',
        claimantAddress: 'Private address',
        claimantPhone: '+1 555 0100',
        materialLocation: 'Reported image',
        goodFaith: true,
        accurateAndAuthorizedUnderPerjury: true,
      },
    });
    await json(await claim(copyright), 200);
    const removal = await input(copyright, [target(copyrightAsset)], staff, 'interim_restrict');
    await json(await decide(removal), 202);
    const removed = await json<DecisionResult>(await decide(removal), 200);
    expect(removed.operation.status).toBe('completed');
    const dmcaNotices = await json<typeof notices>(
      await call('GET', '/v1/safety-notices', undefined, author.token),
      200,
    );
    const dmcaNotice = dmcaNotices.items.find((item) => item.caseId === copyright.caseId)!;
    const counter = await json<{ stepId: string }>(
      await call(
        'POST',
        `/v1/public-reports/${copyright.caseId}/correspondence`,
        {
          kind: 'counter_notice',
          statement: 'Mistaken identification',
          contentLanguage: 'sw-KE',
          counterNotice: {
            signature: 'Uploader',
            name: 'Uploader',
            address: 'Private address',
            phone: '+1 555 0100',
            materialLocation: 'Reported original',
            courtJurisdiction: 'US district court',
            goodFaithMistakeUnderPerjury: true,
            consentToJurisdiction: true,
            acceptService: true,
          },
        },
        undefined,
        randomUUID(),
        dmcaNotice.credential,
      ),
      200,
    );
    clock = new Date();
    expect((await new RightsCounterNotices(stack.accessPool, governance,
      async () => 'sent', () => clock).runPage()).deferred).toBe(0);
    const restoration = {
      ...(await input(copyright, [target(copyrightAsset)], staff, 'restore')),
      answersStepId: counter.stepId,
    };
    expect((await decide(restoration)).status).toBe(409);
    const dmcaStatus = await json<{ items: Array<{ kind: string; dueAt: string | null }> }>(
      await call(
        'GET',
        `/v1/public-reports/${copyright.caseId}`,
        undefined,
        undefined,
        undefined,
        dmcaNotice.credential,
      ),
      200,
    );
    clock = new Date(
      Date.parse(dmcaStatus.items.find((step) => step.kind === 'restoration_not_after')!.dueAt!) +
        86_400_000,
    );
    await json(await claim(copyright), 200);
    await json(await decide(restoration), 202);
    await json(await decide(restoration), 200);
    expect((await stack.store.readAsset(copyrightAsset.asset))!.moderation).toBe('none');
    await governance.recordStep(staff.principal, {
      caseId: copyright.caseId,
      decisionId: removed.decisionId,
      actingSubject: staff.actor,
      process: 'dmca_512',
      step: 'claimant_action',
      partySubject: null,
      statement: 'Claimant filed an action seeking a court order.',
      documentDigest: sha('claimant-action'),
      occurredAt: clock.toISOString(),
      dueAt: null,
      idempotencyKey: randomUUID(),
    });
    const stayedRestoration = await input(copyright, [target(copyrightAsset)], staff, 'restore');
    stayedRestoration.answersStepId = counter.stepId;
    expect((await decide(stayedRestoration)).status).toBe(409);

    // Cancelling a partial plan preserves its first owner receipt and stops the second.
    const cancelledCase = await report(copyrightAsset.asset);
    await json(await claim(cancelledCase), 200);
    const cancelInput = await input(cancelledCase, [
      target(copyrightAsset),
      target(copyrightAsset, 'search'),
    ]);
    const pending = await json<DecisionResult>(await decide(cancelInput), 202);
    interruptOrdinal = 2;
    const beforeCancel = await json<DecisionResult>(await decide(cancelInput), 202);
    const deniedCancelKey = randomUUID();
    expect(
      (
        await call(
          'POST',
          `/v1/safety-decisions/${pending.decisionId}/cancellation`,
          { actingSubject: other.actor, idempotencyKey: deniedCancelKey },
          other.token,
          deniedCancelKey,
        )
      ).status,
    ).toBe(403);
    const cancelKey = randomUUID();
    const cancelled = await json<DecisionResult>(
      await call(
        'POST',
        `/v1/safety-decisions/${pending.decisionId}/cancellation`,
        { actingSubject: staff.actor, idempotencyKey: cancelKey },
        staff.token,
        cancelKey,
      ),
      200,
    );
    expect(cancelled.operation.status).toBe('cancelled');
    expect(cancelled.operation.items[0]!.receipt).toBe(beforeCancel.operation.items[0]!.receipt);
    const cancelledReplay = await json<DecisionResult>(await decide(cancelInput), 202);
    expect(cancelledReplay.operation.status).toBe('cancelled');
    expect(applied.get(`governance-moderation:${pending.decisionId}:2`)).toBeUndefined();
    const reversePartial = await input(
      cancelledCase,
      [target(copyrightAsset)],
      staff,
      'reverse',
      pending.decisionId,
    );
    await json(await decide(reversePartial), 202);
    const partialReversal = await json<DecisionResult>(await decide(reversePartial), 200);
    expect(partialReversal.operation.status).toBe('completed');
    expect((await stack.store.readAsset(copyrightAsset.asset))!.moderation).toBe('none');
  } finally {
    await stack.stop();
  }
}, 180_000);
