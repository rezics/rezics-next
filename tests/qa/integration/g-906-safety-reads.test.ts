import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import {
  GovernanceStore,
  SAFETY_CASE_READ_COST,
  type DecisionInput,
  type DecisionResult,
  type StatementOfReasons,
} from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import {
  ownerEvidenceCapture,
  ownerTargetHeads,
} from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { PublicReports } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { SAFETY_QUEUE_COST } from '../../../services/main/src/modules/safety-queue/store.ts';
import { fixtureReasons } from './g-565-decision-support.ts';
import { startMediaStack, png, sha } from './media-support.ts';

type Receipt = { caseId: string; reportId: string; credential: string; receivedAt: string };
type CaseView = {
  generation: string;
  reports: Array<{ evidenceDigest: string }>;
  decision:
    | (DecisionResult & {
        statementOfReasons: StatementOfReasons & { rule: DecisionInput['rule'] };
      })
    | null;
  steps: Array<{
    id: string;
    kind: string;
    process: string;
    reportId: string | null;
    statement: string | null;
    dueAt: string | null;
    declarations: Record<string, unknown> | null;
  }>;
  stepsNextCursor: string | null;
  reportsNextCursor: string | null;
};
type QueuePage = {
  items: Array<{
    caseId: string;
    urgent: boolean;
    restricted: boolean;
    category: string | null;
    dueAt: string | null;
    target: { resource: string } | null;
    decisionHead: string | null;
    claimedBy: string | null;
    contentLanguage: string | null;
  }>;
  nextCursor: string | null;
};

test('G-906: staff read and answer NCII appeals, see redacted urgency, traverse urgent-first pages and read DMCA windows and reasons', async () => {
  const stack = await startMediaStack('g-906');
  try {
    const language = `x-g906-${randomUUID().slice(0, 8)}`;
    const queuePath = `/v1/safety-cases?contentLanguage=${language}`;
    const staff = await stack.member('specialist');
    const general = await stack.member('general-staff');
    const author = await stack.member('author');
    for (const member of [staff, general])
      for (const action of [
        'governance.moderate',
        'governance.rights.decide',
        'governance.rule.publish',
      ])
        await member.grant('governance:platform', action);
    await staff.grant('governance:platform', 'governance.safety.evidence');
    let statements = 0;
    const measured = new Proxy(stack.accessPool, {
      get(pool, property) {
        if (property === 'connect')
          return async () => {
            const client = await pool.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return (...args: unknown[]) => {
                    statements++;
                    return Reflect.apply(connection.query, connection, args);
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
    const rules = new GovernanceRules(stack.accessPool);
    const governance = new GovernanceStore(
      measured,
      ownerEvidenceCapture({
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
      }),
      ownerTargetHeads({ graph: stack.env, content: stack.contentPool }),
      rules,
      ownerModerationEffects(new ContentModeration(stack.contentPool), stack.env, {
        pool: stack.contentPool,
        core: stack.content,
      }),
    );
    const tokens = new Map(
      [staff, general, author].map((member) => [member.token, member.principal]),
    );
    const deps: MainWorkDependencies = {
      environment: stack.env,
      access: stack.access,
      content: stack.content,
      contentAuthoring: stack.content,
      media: stack.media,
      mediaAccess: stack.mediaAccess,
      governance: { store: governance, rules },
      account: {
        verify: async (request) => {
          const principal = tokens.get(
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
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      if (response.status !== status)
        throw new Error(`expected ${status}, got ${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const report = (asset: string, category: string, extra = {}) =>
      call('POST', '/v1/public-reports', {
        profile: 'public-report-v1',
        target: `https://rezics.com/id/${asset}`,
        category,
        statement: 'Retained private report',
        contentLanguage: language,
        ...extra,
      });
    const read = (path: string, member = staff) =>
      call(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(member.actor)}`,
        undefined,
        member.token,
      );
    const readCase = async (receipt: Receipt, query = '') => {
      const before = statements;
      const response = await read(`/v1/safety-cases/${receipt.caseId}${query}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const view = await json<CaseView>(response);
      expect(statements - before).toBeLessThanOrEqual(SAFETY_CASE_READ_COST.statements);
      return view;
    };
    const claim = async (receipt: Receipt) => {
      const key = randomUUID();
      await json(
        await call(
          'POST',
          `/v1/safety-cases/${receipt.caseId}/claim`,
          { actingSubject: staff.actor, idempotencyKey: key },
          staff.token,
          key,
        ),
      );
    };
    // The ordinary case opens first. Priority must outrank opening time.
    const ordinaryAsset = await author.upload(png(20, 20));
    const ordinary = await json<Receipt>(await report(ordinaryAsset.asset, 'harassment'), 201);
    const image = await author.upload(png(21, 21));
    const ncii = await json<Receipt>(
      await report(image.asset, 'ncii', {
        contactEmail: 'safe@example.test',
        ncii: {
          signature: 'Depicted person',
          depictedPersonOrAuthorized: true,
          goodFaithWithoutConsent: true,
          supportingInformation: 'Identified depiction',
        },
      }),
      201,
    );
    // Two timestamp ties in each urgency class exercise the final UUID key.
    const seeded: string[] = [];
    for (const urgent of [false, false, true, true]) {
      const caseId = randomUUID();
      seeded.push(caseId);
      await stack.accessPool.query(
        `INSERT INTO access.governance_case
        (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure,urgent,opened_at)
        VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,'title','private',$3,$4)`,
        [
          caseId,
          `https://rezics.com/id/${randomUUID()}`,
          urgent,
          urgent ? '2026-08-02T00:00:00.123456Z' : '2026-08-01T00:00:00.123456Z',
        ],
      );
      await stack.accessPool.query(
        `INSERT INTO access.governance_report
        (id,case_id,idempotency_key,request_digest,reason_code,evidence_count,evidence_digest,content_language)
        VALUES ($1,$2,$3,$4,$5,1,$4,$6)`,
        [
          randomUUID(),
          caseId,
          randomUUID(),
          sha(caseId),
          urgent ? 'credible_threat' : 'harassment',
          language,
        ],
      );
    }
    const queue = async (member = staff, cursor?: string) => {
      const before = statements;
      const page = await json<QueuePage>(
        await read(
          `${queuePath}&limit=2` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
          member,
        ),
      );
      expect(statements - before).toBeLessThanOrEqual(SAFETY_QUEUE_COST.readStatements);
      return page;
    };
    const first = await queue(general);
    const second = await queue(general, first.nextCursor!);
    const third = await queue(general, second.nextCursor!);
    const rows = [...first.items, ...second.items, ...third.items];
    expect(rows.map((row) => row.urgent)).toEqual([true, true, true, false, false, false]);
    expect(new Set(rows.map((row) => row.caseId))).toEqual(
      new Set([ordinary.caseId, ncii.caseId, ...seeded]),
    );
    expect(third.nextCursor).toBeNull();
    expect(first.items.map((row) => row.caseId)).toEqual(seeded.slice(2).sort());
    expect(rows.slice(3, 5).map((row) => row.caseId)).toEqual(seeded.slice(0, 2).sort());
    const redacted = rows.find((row) => row.caseId === ncii.caseId)!;
    expect(redacted).toMatchObject({
      restricted: true,
      category: 'ncii',
      urgent: true,
      dueAt: new Date(Date.parse(ncii.receivedAt) + 48 * 3600_000).toISOString(),
      target: null,
      decisionHead: null,
      claimedBy: null,
      contentLanguage: null,
    });
    expect(Object.keys(redacted).sort()).toEqual(
      [
        'caseId',
        'kind',
        'urgent',
        'restricted',
        'generation',
        'decisionHead',
        'openedAt',
        'target',
        'category',
        'contentLanguage',
        'dueAt',
        'claimedBy',
      ].sort(),
    );
    expect((await read(`/v1/safety-cases/${ncii.caseId}`, general)).status).toBe(403);
    expect((await read(`/v1/reports/${ncii.reportId}`, general)).status).toBe(404);
    const generalClaimKey = randomUUID();
    expect(
      (
        await call(
          'POST',
          `/v1/safety-cases/${ncii.caseId}/claim`,
          { actingSubject: general.actor, idempotencyKey: generalClaimKey },
          general.token,
          generalClaimKey,
        )
      ).status,
    ).toBe(403);
    const specialistQueue = await json<QueuePage>(await read(`${queuePath}&urgent=true`));
    expect(specialistQueue.items.find((row) => row.caseId === ncii.caseId)).toMatchObject({
      restricted: false,
      target: { resource: `https://rezics.com/id/${image.asset}` },
    });
    // The same continuation loses validity when specialist authority changes.
    expect(
      (await read(`${queuePath}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, staff))
        .status,
    ).toBe(400);
    expect(
      (
        await read(
          `${queuePath}&limit=2&urgent=true&cursor=${encodeURIComponent(first.nextCursor!)}`,
          general,
        )
      ).status,
    ).toBe(400);

    const ruleKey = randomUUID();
    const published = await json<DecisionInput['rule']>(
      await call(
        'POST',
        '/v1/governance/rules',
        {
          profile: 'governance-rule-v1',
          ref: `urn:g906:rule:${randomUUID()}`,
          scopeId: 'governance:platform',
          actingSubject: staff.actor,
          expectedRevision: null,
          document: { rule: 'Reviewed safety rule' },
          idempotencyKey: ruleKey,
        },
        staff.token,
        ruleKey,
      ),
      201,
    );
    const rule = { ref: published.ref, revision: published.revision, digest: published.digest };
    const input = async (
      receipt: Receipt,
      asset: typeof image,
      outcome: DecisionInput['outcome'] = 'restrict',
    ): Promise<DecisionInput> => {
      await claim(receipt);
      const view = await readCase(receipt);
      return {
        caseId: receipt.caseId,
        expectedGeneration: view.generation,
        actingSubject: staff.actor,
        outcome,
        targets: [
          {
            owner: 'content',
            resource: `https://rezics.com/id/${asset.asset}`,
            component: 'body',
            locator: null,
            scopeKind: 'exact_revision',
            revision: asset.revision,
            expectedHead: asset.revision,
            effect: 'disclosure',
          },
        ],
        rule,
        evidenceDigest: view.reports[0]!.evidenceDigest,
        reversesDecisionId: null,
        answersStepId: null,
        rationale: 'Retained findings',
        disclosure: 'parties',
        reasons: fixtureReasons,
        idempotencyKey: randomUUID(),
      };
    };
    const decide = (body: DecisionInput) =>
      call(
        'POST',
        `/v1/safety-cases/${body.caseId}/decisions`,
        body,
        staff.token,
        body.idempotencyKey,
      );
    const complete = async (body: DecisionInput) => {
      const accepted = await json<DecisionResult>(await decide(body), 202);
      expect(accepted.operation.status).toBe('accepted');
      const done = await json<DecisionResult>(await decide(body));
      expect(done.operation.status).toBe('completed');
      return done;
    };
    const restriction = await complete(await input(ncii, image));
    expect(
      (await read(`${queuePath}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, general))
        .status,
    ).toBe(409);
    expect((await readCase(ncii)).decision?.statementOfReasons).toEqual({
      ...fixtureReasons,
      rule,
    });
    const affectedCredential = async (caseId: string) => {
      const notices = await json<{ items: Array<{ caseId: string; credential: string }> }>(
        await call('GET', '/v1/safety-notices', undefined, author.token),
      );
      return notices.items.find((notice) => notice.caseId === caseId)!.credential;
    };
    const credential = await affectedCredential(ncii.caseId);
    await json(
      await call(
        'POST',
        `/v1/public-reports/${ncii.caseId}/correspondence`,
        {
          kind: 'appeal',
          statement: 'Please reconsider the retained evidence',
          contentLanguage: 'en',
        },
        undefined,
        randomUUID(),
        credential,
      ),
    );
    const appealed = await readCase(ncii);
    const appeal = appealed.steps.find((step) => step.kind === 'appeal')!;
    expect(appeal).toMatchObject({
      reportId: ncii.reportId,
      process: 'platform_appeal',
      statement: 'Please reconsider the retained evidence',
    });
    expect(appealed.steps.find((step) => step.kind === 'removal_deadline')?.dueAt).toBe(
      redacted.dueAt,
    );
    const reverse = {
      ...(await input(ncii, image, 'reverse')),
      reversesDecisionId: restriction.decisionId,
      answersStepId: appeal.id,
    };
    expect((await decide({ ...reverse, answersStepId: null })).status).toBe(400);
    const reversed = await complete(reverse);
    expect((await stack.store.readAsset(image.asset))!.moderation).toBe('none');
    expect((await readCase(ncii)).decision?.decisionId).toBe(reversed.decisionId);

    const copyrightImage = await author.upload(png(22, 22));
    const copyright = await json<Receipt>(
      await report(copyrightImage.asset, 'copyright', {
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
      }),
      201,
    );
    await complete(await input(copyright, copyrightImage, 'interim_restrict'));
    const copyrightCredential = await affectedCredential(copyright.caseId);
    const declarations = {
      signature: 'Uploader',
      name: 'Uploader',
      address: 'Private address',
      phone: '+1 555 0100',
      materialLocation: 'Reported original',
      courtJurisdiction: 'US district court',
      goodFaithMistakeUnderPerjury: true,
      consentToJurisdiction: true,
      acceptService: true,
    };
    const counter = await json<{ stepId: string }>(
      await call(
        'POST',
        `/v1/public-reports/${copyright.caseId}/correspondence`,
        {
          kind: 'counter_notice',
          statement: 'Mistaken identification',
          contentLanguage: 'en',
          counterNotice: declarations,
        },
        undefined,
        randomUUID(),
        copyrightCredential,
      ),
    );
    const legal = await readCase(copyright);
    expect(legal.steps.find((step) => step.id === counter.stepId)).toMatchObject({
      kind: 'counter_notice',
      process: 'dmca_512',
      statement: 'Mistaken identification',
      declarations,
    });
    const earliest = legal.steps.find((step) => step.kind === 'restoration_not_before')!;
    const latest = legal.steps.find((step) => step.kind === 'restoration_not_after')!;
    expect(Date.parse(latest.dueAt!)).toBeGreaterThan(Date.parse(earliest.dueAt!));
    expect(legal.decision?.statementOfReasons).toEqual({ ...fixtureReasons, rule });
    // More than one response bound: no correspondence vanishes after fifty steps.
    for (let index = 0; index < 52; index++)
      await json(
        await call(
          'POST',
          `/v1/public-reports/${copyright.caseId}/correspondence`,
          { kind: 'message', statement: `Message ${index}`, contentLanguage: 'en' },
          undefined,
          randomUUID(),
          copyrightCredential,
        ),
      );
    const steps = new Set<string>();
    let stepCursor: string | null = null;
    do {
      const page = await readCase(copyright, stepCursor ? `?stepCursor=${stepCursor}` : '');
      expect(page.reports).toHaveLength(1);
      expect(page.reportsNextCursor).toBeNull();
      expect(page.steps.length).toBeLessThanOrEqual(SAFETY_CASE_READ_COST.page);
      for (const step of page.steps) {
        expect(steps.has(step.id)).toBe(false);
        steps.add(step.id);
      }
      stepCursor = page.stepsNextCursor;
    } while (stepCursor);
    expect(steps.size).toBe(legal.steps.length + 52);
    expect(steps.has(latest.id)).toBe(true);
    expect(
      (await read(`/v1/safety-cases/${ncii.caseId}?stepCursor=${latest.id}`, general)).status,
    ).toBe(403);
  } finally {
    await stack.stop();
  }
}, 120_000);
