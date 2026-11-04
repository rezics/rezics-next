import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import decisionSource from '../../src/content/decision-page-source.sql';
import { newId } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, type Capture } from '../support/growth.ts';
import {
  createGrowthAppealBoundariesFixture,
  type DecisionPageHistoryAxis,
} from './support/growth-appeal-boundaries-fixture.ts';

const scales = [256, 1024, 4096] as const;
const axes: readonly DecisionPageHistoryAxis[] = [
  'unrelated-decisions',
  'target-decisions',
  'appeals',
  'identity-history',
  'authority-history',
];
const relations = [
  'content.moderation_decision',
  'content.moderation_appeal',
  'content.moderation_appeal_board',
  'content.board',
  'content.thread',
  'content.post',
  'access.account',
  'access.resource_grant',
];
const countedBounds = {
  httpRequests: 'constant',
  httpRequestUtf8: 'constant',
  httpResponseUtf8: 'constant',
  jsonCopies: 'constant',
  jsonStringifies: 'constant',
  jsonSerializedUtf8: 'constant',
  jsonParses: 'constant',
  jsonParsedUtf8: 'constant',
  runnerPhases: 'constant',
} as const;

let fixture: Awaited<ReturnType<typeof createGrowthAppealBoundariesFixture>>;

beforeAll(async () => {
  fixture = await createGrowthAppealBoundariesFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.close();
});

function explainNodes(document: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record['Node Type'] === 'string') nodes.push(record);
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(document);
  return nodes;
}

function assertExactSourcePlans(captures: readonly Capture[]): void {
  const plans: Array<{ sql: string; nodes: Record<string, unknown>[] }> = [];
  for (const capture of captures) {
    const sourceStatements = capture.statements.flatMap((sql, index) =>
      /FROM\s+content\.moderation_decision\s+d\b/i.test(sql) ? [index] : [],
    );
    for (let index = 0; index < capture.plans.length; index++) {
      const statement = capture.planStatements?.[index];
      if (statement === undefined || !sourceStatements.includes(statement)) continue;
      plans.push({ sql: capture.statements[statement]!, nodes: explainNodes(capture.plans[index]) });
    }
  }
  expect(plans.length, 'the native source query has physical plan evidence').toBeGreaterThan(0);

  for (const { sql, nodes } of plans) {
    expect(sql).toMatch(
      /LEFT JOIN\s+content\.moderation_appeal\s+a\s+ON\s+a\.route\s*=\s*d\.route\s+AND\s+a\.decision_id\s*=\s*d\.decision_id/i,
    );
    expect(sql).toMatch(
      /LEFT JOIN\s+content\.board\s+b\s+ON\s+d\.target_kind\s*=\s*'board'\s+AND\s+b\.route\s*=\s*d\.route\s+AND\s+b\.board_id\s*=\s*d\.target_id/i,
    );
    expect(sql).toMatch(
      /LEFT JOIN\s+content\.thread\s+t\s+ON\s+d\.target_kind\s*=\s*'thread'\s+AND\s+t\.route\s*=\s*d\.route\s+AND\s+t\.thread_id\s*=\s*d\.target_id/i,
    );
    expect(sql).toMatch(
      /LEFT JOIN\s+content\.post\s+p\s+ON\s+d\.target_kind\s*=\s*'post'\s+AND\s+p\.route\s*=\s*d\.route\s+AND\s+p\.post_id\s*=\s*d\.target_id/i,
    );
    expect(sql).toMatch(
      /LEFT JOIN\s+content\.thread\s+parent\s+ON\s+d\.target_kind\s*=\s*'post'\s+AND\s+parent\.route\s*=\s*p\.route\s+AND\s+parent\.thread_id\s*=\s*p\.thread_id/i,
    );

    const indexed = (relation: string, key: string) =>
      nodes.some((node) => {
        const label = [node['Relation Name'], node['Alias'], node['Index Name']].join(' ');
        const condition = String(node['Index Cond'] ?? '');
        return (
          /Index/.test(String(node['Node Type'])) &&
          label.includes(relation) &&
          /route/i.test(condition) &&
          new RegExp(key, 'i').test(condition)
        );
      });
    expect(indexed('moderation_decision', 'decision_id'), 'decision lookup uses the full home and selected key').toBe(
      true,
    );
    expect(indexed('moderation_appeal', 'decision_id'), 'appeal residual uses the full home and decision key').toBe(
      true,
    );
    expect(indexed('board', 'board_id'), 'board residual uses the full home and board key').toBe(true);
    expect(indexed('thread', 'thread_id'), 'thread residual uses the full home and thread key').toBe(true);
    expect(indexed('post', 'post_id'), 'post residual uses the full home and post key').toBe(true);
  }
}

async function withJsonMeter<T>(operation: () => Promise<T>) {
  const meter = { stringifies: 0, serializedUtf8: 0, parses: 0, parsedUtf8: 0 };
  const originalStringify = JSON.stringify;
  const originalParse = JSON.parse;
  Object.defineProperty(JSON, 'stringify', {
    configurable: true,
    writable: true,
    value: (value: unknown, replacer?: unknown, space?: unknown) => {
      const text = originalStringify(value as never, replacer as never, space as never);
      if (typeof text === 'string') {
        meter.stringifies++;
        meter.serializedUtf8 += Buffer.byteLength(text, 'utf8');
      }
      return text;
    },
  });
  Object.defineProperty(JSON, 'parse', {
    configurable: true,
    writable: true,
    value: (text: string, reviver?: unknown) => {
      meter.parses++;
      meter.parsedUtf8 += Buffer.byteLength(text, 'utf8');
      return originalParse(text, reviver as never);
    },
  });
  try {
    return { value: await operation(), meter };
  } finally {
    Object.defineProperty(JSON, 'stringify', { configurable: true, writable: true, value: originalStringify });
    Object.defineProperty(JSON, 'parse', { configurable: true, writable: true, value: originalParse });
  }
}

test('exact decision pages retain bounded native work across independent histories and withheld paths', async () => {
  const { db, people, base } = fixture;
  const boardId = base.mainBoardId;
  const authorTarget = await fixture.createThread(boardId, 'Fixed decision page author target');
  const authorDecision = await fixture.createDecision(authorTarget);
  const postTarget = await fixture.createThread(boardId, 'Fixed decision page post target', authorTarget.threadId);
  const postDecision = await fixture.createDecision(postTarget, 'post');
  const moderatorTarget = await fixture.createThread(
    boardId,
    'Fixed decision page moderator target',
    authorTarget.threadId,
  );
  await fixture.grant(boardId, people.reviewer.accountId, ['moderation:read_reports']);
  const submitted = await fixture.submitAppeal(boardId, moderatorTarget);
  await fixture.resolveAppeal(submitted.record, 'reverse');
  const unrelatedTarget = await fixture.createThread(
    boardId,
    'Unrelated decision page pressure target',
    authorTarget.threadId,
  );
  const authorRoute = fixture.routed(authorDecision.decisionId);
  expect(fixture.routed(authorTarget.threadId)).toBe(authorRoute);
  expect(fixture.routed(unrelatedTarget.threadId)).toBe(authorRoute);
  expect(fixture.routed(postTarget.threadId)).toBe(authorRoute);
  expect(fixture.routed(moderatorTarget.threadId)).toBe(authorRoute);

  const emptyId = newId(authorRoute);
  const emptyPath = `/v1/moderation-decisions/${emptyId}`;
  const appealTag = `decision-page-appeals-${randomUUID()}`;
  await fixture.seedDecisionPageDecisionHistory(db, authorTarget.threadId, appealTag, 4096);

  for (const axis of axes) {
    const name = `decision page ${axis}`;
    const tag = `${name}-${randomUUID()}`;
    const captures: Capture[] = [];
    const ensureModeratorGrant = async () => {
      await fixture.revokeCurrentTargetModeration(moderatorTarget.threadId, people.reviewer.accountId);
      await fixture.grant(moderatorTarget.threadId, people.reviewer.accountId, ['moderation:takedown']);
    };
    const pagePaths = async () => {
      const requestMetrics = { httpRequests: 0, httpRequestUtf8: 0, httpResponseUtf8: 0 };
      const read = async (path: string, bearer: string) => {
        requestMetrics.httpRequests++;
        requestMetrics.httpRequestUtf8 += Buffer.byteLength(
          `GET https://appeal-boundaries.test${path}\nauthorization: Bearer ${bearer}\n`,
          'utf8',
        );
        const result = await fixture.call('GET', path, { bearer });
        requestMetrics.httpResponseUtf8 += Buffer.byteLength(result.text, 'utf8');
        return result;
      };
      const sourceBefore = fixture.runnerPhases.length;
      const measured = await withJsonMeter(async () => {
        const author = await read(authorDecision.path, people.author.bearer);
        const post = await read(postDecision.path, people.author.bearer);
        const moderatorPath = `/v1/moderation-decisions/${submitted.record.decisionId}`;
        const moderator = await read(moderatorPath, people.reviewer.bearer);
        const empty = await read(emptyPath, people.author.bearer);
        const denied = await read(moderatorPath, people.reporter.bearer);
        await fixture.revokeCurrentTargetModeration(moderatorTarget.threadId, people.reviewer.accountId);
        const revoked = await read(moderatorPath, people.reviewer.bearer);
        const barrier = fixture.observer.hold({ statement: decisionSource.sql, occurrence: 1 }, 'after');
        const withheld = (async () => {
          const request = read(authorDecision.path, people.author.bearer);
          let changed = false;
          try {
            await barrier.entered;
            await db.pool.query(
              `UPDATE content.moderation_decision SET statement='Changed during exact page read'
               WHERE route=$1 AND decision_id=$2`,
              [authorRoute, authorDecision.decisionId],
            );
            changed = true;
            barrier.release();
            return await request;
          } finally {
            barrier.release();
            if (changed)
              await db.pool.query(
                `UPDATE content.moderation_decision SET statement='Policy violation'
                 WHERE route=$1 AND decision_id=$2`,
                [authorRoute, authorDecision.decisionId],
              );
          }
        })();
        const withheldResult = await withheld;
        return { author, post, moderator, empty, denied, revoked, withheld: withheldResult };
      });
      const { author, post, moderator, empty, denied, revoked, withheld } = measured.value;
      expect(author.response.status).toBe(200);
      expect(author.body?.viewer.appeal).toEqual({ state: 'permitted' });
      expect(author.body?.targetContext).toEqual({ state: 'concealed' });
      expect(post.response.status).toBe(200);
      expect(post.body?.viewer.appeal).toEqual({ state: 'permitted' });
      expect(post.body).not.toHaveProperty('targetText');
      expect(moderator.response.status).toBe(200);
      expect(moderator.body?.viewer).toMatchObject({ affectedAuthor: false });
      expect(empty.response.status).toBe(404);
      expect(denied.response.status).toBe(404);
      expect(revoked.response.status).toBe(404);
      expect(withheld.response.status).toBe(404);
      expect(withheld.text).not.toContain('Changed during exact page read');
      const json = measured.meter;
      const runnerPhases = fixture.runnerPhases.length - sourceBefore;
      return {
        metrics: {
          ...requestMetrics,
          jsonCopies: json.stringifies + json.parses,
          jsonStringifies: json.stringifies,
          jsonSerializedUtf8: json.serializedUtf8,
          jsonParses: json.parses,
          jsonParsedUtf8: json.parsedUtf8,
          runnerPhases,
        },
      };
    };

    const report = await checkGrowth(db, {
      name,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      counted: { bounds: countedBounds, read: (value) => (value as { metrics: Record<string, number> }).metrics },
      repetitions: 1,
      includeBackends: true,
      grow: (database, scale, previous) =>
        fixture.seedDecisionPageHistory(
          database,
          axis,
          axis === 'appeals' ? appealTag : tag,
          scale,
          previous,
          boardId,
          authorTarget.threadId,
          unrelatedTarget.threadId,
          moderatorTarget.threadId,
        ),
      warmup: async () => {
        await ensureModeratorGrant();
        await pagePaths();
      },
      prepare: ensureModeratorGrant,
      operation: pagePaths,
      aggregateCaptures(primary) {
        captures.push(primary);
        return { capture: primary, databases: [{ name: 'kernel', capture: primary }] };
      },
    });
    assertGrowthAccessPaths(name, report.samples, relations);
    assertExactSourcePlans(captures);
    for (const sample of report.samples) {
      expect(sample.cost.controlStatements).toBeGreaterThan(0);
      expect(sample.cost.failedStatements ?? {}).toEqual({});
      expect(sample.backendRepetitions?.every((backends) => backends.length > 0)).toBe(true);
      expect(sample.coldBackendExhaustion ?? []).toEqual([]);
    }
    for (const sample of report.samples) {
      expect(sample.counted?.httpRequests?.value).toBe(7);
      expect(sample.counted?.runnerPhases?.value).toBe(0);
      expect(sample.counted?.jsonCopies?.repetitions).toHaveLength(1);
    }
    console.info(
      JSON.stringify({
        name,
        samples: report.samples.map((sample) => ({
          scale: sample.scale,
          statements: sample.cost.statements,
          controls: sample.cost.controlStatements,
          rows: sample.cost.rows,
          blocks: sample.cost.blocks,
          requestBytes: sample.cost.requestBytes,
          responseBytes: sample.cost.responseBytes,
          coldBackendDiscards: sample.coldBackendDiscards,
          counted: sample.counted,
        })),
      }),
    );
  }
}, 1_800_000);
