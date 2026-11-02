import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Board, Content, ContentDisclosureDriver, Persona, Reply, Target } from './content-disclosure-driver';

setDefaultTimeout(30_000);
let driver: ContentDisclosureDriver | undefined;
const d = () => {
  if (!driver) throw new Error('Content disclosure driver was not initialized');
  return driver;
};
beforeEach(async () => {
  const location = process.env.CONTENT_DISCLOSURE_DRIVER;
  if (!location) throw new Error('Content disclosure outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('CONTENT_DISCLOSURE_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Content disclosure driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createContentDisclosureDriver !== 'function') {
    throw new Error('Content disclosure driver must export createContentDisclosureDriver');
  }
  driver = await binding.createContentDisclosureDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});

async function wire(reply: Reply<unknown>): Promise<string> {
  return reply.response.clone().text();
}
async function ok<T>(reply: Reply<T>): Promise<T> {
  expect(reply.response.status).toBeGreaterThanOrEqual(200);
  expect(reply.response.status).toBeLessThan(300);
  expect(reply.value).toBeDefined();
  return reply.value!;
}
async function problem(
  reply: Reply<unknown>,
  code: 'not_found' | 'invalid_request' | 'forbidden' | 'idempotency_conflict',
  write = code === 'forbidden' || code === 'idempotency_conflict',
) {
  const status = { not_found: 404, invalid_request: 400, forbidden: 403, idempotency_conflict: 422 }[code];
  expect(reply.response.status).toBe(status);
  expect(reply.response.headers.get('content-type')).toContain('application/problem+json');
  expect(reply.value).toBeUndefined();
  const body = await reply.response.clone().json();
  expect(body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    code,
    status,
    retryable: false,
    effect_status: write ? 'not_applied' : 'not_applicable',
  });
  expect(typeof body.request_id).toBe('string');
  const { request_id: _request, ...stable } = body;
  expect(
    Object.keys(stable).every((key) =>
      ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'detail', 'errors'].includes(key),
    ),
  ).toBe(true);
  return stable;
}
async function denied(reply: Reply<unknown>, secrets: string[] = [], read = false, malformed = false) {
  expect(malformed ? [400, 401, 403, 404] : [401, 403, 404]).toContain(reply.response.status);
  expect(reply.value).toBeUndefined();
  expect(reply.response.headers.get('content-type')).toContain('application/problem+json');
  const body = await reply.response.clone().json();
  expect(body.effect_status).toBe(read ? 'not_applicable' : 'not_applied');
  for (const secret of secrets) expect(await wire(reply)).not.toContain(secret);
}
async function fixture(body = 'disclosure-public-text') {
  const board = await d().board();
  const thread = await d().publish({ board, body, missingSemanticSubject: true });
  expect(thread.partition).not.toBe(board.partition);
  await d().projection('drain');
  return { board, thread };
}
async function listed(persona: Persona, board: Target) {
  return ok(await d().list(persona, board, { limit: 10 }));
}
async function hidden(persona: Persona, target: Board | Content) {
  const missing = d().missing(target.kind);
  expect(await problem(await d().read(persona, target), 'not_found')).toEqual(
    await problem(await d().read(persona, missing), 'not_found'),
  );
  if (target.kind === 'board') return;
  expect(await problem(await d().read(persona, target, target.revision.id), 'not_found')).toEqual(
    await problem(await d().read(persona, missing, target.revision.id), 'not_found'),
  );
}

test('unknown and hidden thread post and exact revisions have indistinguishable not found problems', async () => {
  const { board, thread } = await fixture();
  const post = await d().publish({ board, thread, body: 'history-secret-post' });
  for (const target of [post, thread]) {
    await ok(await d().read('anonymous', target, target.revision.id));
    const unknownRevision = await problem(await d().read('anonymous', target, d().missing('post').id), 'not_found');
    await d().protect(target);
    for (const persona of ['anonymous', 'unrelated'] as const) {
      await hidden(persona, target);
      const response = await d().read(persona, target, target.revision.id);
      expect(await problem(response, 'not_found')).toEqual(unknownRevision);
      expect(await wire(response)).not.toContain(target.revision.body!);
    }
  }
});

test('board keyset ordering breaks ties and newer inserts do not repeat prior items', async () => {
  const board = await d().board();
  const threads: Content[] = [];
  for (let i = 0; i < 5; i++)
    threads.push(await d().publish({ board, body: `ordered-${i}`, createdAt: '2026-01-01T00:00:00Z' }));
  await d().projection('drain');
  const expected = threads
    .map((t) => t.id)
    .sort()
    .reverse();
  const first = await ok(await d().list('anonymous', board, { limit: 2, sort: 'newest' }));
  expect(first.items.map((t) => t.id)).toEqual(expected.slice(0, 2));
  expect(first.next).toBeTruthy();
  expect((await ok(await d().list('anonymous', board, { limit: 2, sort: 'newest' }))).items).toEqual(first.items);
  await d().publish({ board, body: 'newer-between-pages', createdAt: '2026-01-02T00:00:00Z' });
  await d().projection('drain');
  const seen = first.items.map((t) => t.id);
  let cursor = first.next;
  for (let page = 0; cursor && page < 4; page++) {
    const next = await ok(await d().list('anonymous', board, { limit: 2, cursor, sort: 'newest' }));
    seen.push(...next.items.map((t) => t.id));
    cursor = next.next;
  }
  expect(cursor).toBeNull();
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(seen.length);
});

test('stale board candidates obey current protected thread Access and missing semantic subjects do not block content', async () => {
  const { board, thread } = await fixture();
  expect((await listed('anonymous', board)).items.map((t) => t.id)).toContain(thread.id);
  expect((await ok(await d().read('anonymous', thread))).revision.body).toBe(thread.revision.body);
  await d().projection('pause');
  await d().protect(thread);
  for (const persona of ['anonymous', 'unrelated'] as const) {
    expect((await listed(persona, board)).items).toEqual([]);
    await hidden(persona, thread);
  }
  await d().grantRead('moderator', thread);
  expect((await listed('moderator', board)).items.map((t) => t.id)).toContain(thread.id);
  expect((await ok(await d().read('moderator', thread))).id).toBe(thread.id);
  await d().revokeCreatorReadAuthority(thread);
  // Authorship alone cannot replace a protected read grant.
  await hidden('author', thread);
  await d().grantRead('author', thread);
  expect((await ok(await d().read('author', thread))).id).toBe(thread.id);
});

test('stale descendants obey protected and taken down parent board at board detail and exact history APIs', async () => {
  const { board, thread } = await fixture('board-parent-secret');
  await d().projection('pause');
  await d().protect(board);
  await d().grantRead('moderator', board);
  await d().grantRead('moderator', thread);
  expect((await listed('moderator', board)).items.map((t) => t.id)).toContain(thread.id);
  for (const persona of ['anonymous', 'unrelated'] as const) {
    await hidden(persona, board);
    await hidden(persona, thread);
    expect(await problem(await d().list(persona, board, { limit: 10 }), 'not_found')).toEqual(
      await problem(await d().list(persona, d().missing('board'), { limit: 10 }), 'not_found'),
    );
  }
  await ok(await d().takedown('moderator', board, 'board-takedown'));
  for (const persona of ['anonymous', 'unrelated'] as const) {
    await hidden(persona, thread);
    await problem(await d().list(persona, board, { limit: 10 }), 'not_found');
  }
});

test('nested replies cannot bypass protected or taken down containing post chains', async () => {
  const { board, thread } = await fixture();
  const parent = await d().publish({ board, thread, body: 'parent-secret' });
  const reply = await d().publish({ board, thread, parent, body: 'nested-secret' });
  await ok(await d().read('anonymous', reply));
  await d().protect(parent);
  for (const persona of ['anonymous', 'unrelated'] as const) await hidden(persona, reply);
  const detail = await d().read('anonymous', thread);
  await ok(detail);
  expect(await wire(detail)).not.toContain(parent.revision.body!);
  expect(await wire(detail)).not.toContain(reply.revision.body!);
  await d().grantRead('moderator', parent);
  await d().grantRead('moderator', reply);
  await ok(await d().read('moderator', reply));
  await ok(await d().takedown('moderator', parent, 'parent-takedown'));
  for (const persona of ['anonymous', 'unrelated'] as const) await hidden(persona, reply);
});

test('missing or unavailable container evidence fails closed despite stale visible candidates', async () => {
  for (const failure of ['missing', 'unavailable'] as const) {
    const { board, thread } = await fixture(`evidence-${failure}`);
    await d().projection('pause');
    await d().failContainer(board, failure);
    const read = await d().read('anonymous', thread);
    expect([404, 503]).toContain(read.response.status);
    expect(await wire(read)).not.toContain(thread.revision.body!);
    const page = await d().list('anonymous', board, { limit: 10 });
    expect(await wire(page)).not.toContain(thread.revision.body!);
    if (page.response.ok) expect((await ok(page)).items).toEqual([]);
    else expect([404, 503]).toContain(page.response.status);
  }
});

test('a full hidden candidate page advances to visible candidates without removal counts or reasons', async () => {
  const board = await d().board();
  const visible = await d().publish({ board, body: 'visible-tail', createdAt: '2026-01-01T00:00:00Z' });
  const hiddenRows: Content[] = [];
  for (let i = 0; i < 6; i++)
    hiddenRows.push(await d().publish({ board, body: `hidden-sentinel-${i}`, createdAt: '2026-01-02T00:00:00Z' }));
  await d().projection('drain');
  await d().projection('pause');
  for (const row of hiddenRows) await d().protect(row);
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const response = await d().list('anonymous', board, { limit: 2, ...(cursor ? { cursor } : {}) });
    const page = await ok(response);
    const raw = await wire(response);
    for (const row of hiddenRows) {
      expect(raw).not.toContain(row.id);
      expect(raw).not.toContain(row.revision.body!);
    }
    expect(raw).not.toMatch(/removed|filtered|hidden_count|scanned_count|taken_down|protected/i);
    ids.push(...page.items.map((t) => t.id));
    if (!page.next) {
      cursor = undefined;
      break;
    }
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    cursor = page.next;
  }
  expect(cursor).toBeUndefined();
  expect(ids).toEqual([visible.id]);
});

test('tampered expired wrong board viewer query and sort cursors reject without result bytes', async () => {
  const { board, thread } = await fixture('cursor-result-secret');
  await d().publish({ board, body: 'cursor-second' });
  await d().projection('drain');
  const otherBoard = await d().board();
  const first = await ok(await d().list('anonymous', board, { limit: 1, sort: 'newest', query: '' }));
  expect(first.next).toBeTruthy();
  const cursor = first.next!;
  const tampered = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
  const attempts = [
    d().list('anonymous', board, { limit: 1, cursor: tampered }),
    d().list('anonymous', otherBoard, { limit: 1, cursor }),
    d().list('unrelated', board, { limit: 1, cursor }),
    d().list('anonymous', board, { limit: 1, cursor, query: 'changed' }),
    d().list('anonymous', board, { limit: 1, cursor, sort: 'oldest' }),
  ];
  for (const attempt of attempts) {
    const response = await attempt;
    await problem(response, 'invalid_request');
    expect(await wire(response)).not.toContain(thread.revision.body!);
    expect(await wire(response)).not.toContain('"items"');
  }
  await d().expireCursors();
  const expired = await d().list('anonymous', board, { limit: 1, cursor });
  await problem(expired, 'invalid_request');
  expect(await wire(expired)).not.toContain('"items"');
});

test('moderator takedown changes security revision atomically with one target partition outbox effect', async () => {
  const { board, thread } = await fixture('takedown-secret');
  const before = await d().observe(thread);
  await d().projection('pause');
  const result = await ok(await d().takedown('moderator', thread, 'take-once'));
  const after = await d().observe(thread);
  expect(after.visibility).toBe('taken_down');
  expect(after.securityRevision).not.toBe(before.securityRevision);
  expect(result.securityRevision).toBe(after.securityRevision);
  const effects = after.effects.filter((e) => !before.effects.some((old) => old.id === e.id));
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({
    kind: 'takedown',
    partition: thread.partition,
    transactionId: after.transactionId,
  });
  await ok(await d().takedown('moderator', thread, 'take-once'));
  expect(await d().observe(thread)).toEqual(after);
  for (const persona of ['anonymous', 'unrelated', 'author'] as const) {
    await hidden(persona, thread);
    expect((await listed(persona, board)).items).toEqual([]);
  }
  await d().projection('drain');
  await d().projection('replay');
  expect((await listed('anonymous', board)).items).toEqual([]);
  expect(await d().observe(thread)).toEqual(after);
  await d().protect(thread);
  const protectedState = await d().observe(thread);
  expect(protectedState.securityRevision).not.toBe(after.securityRevision);
  await ok(await d().takedown('moderator', thread, 'take-again'));
  const again = await d().observe(thread);
  expect([before.securityRevision, after.securityRevision, protectedState.securityRevision]).not.toContain(
    again.securityRevision,
  );
});

test('author and suspended callers cannot impersonate moderators and refusals change no state or effects', async () => {
  const { thread } = await fixture();
  const before = await d().observe(thread);
  for (const persona of ['author', 'suspended'] as const) {
    await denied(await d().takedown(persona, thread, `plain-refuse-${persona}`));
    await denied(
      await d().takedown(persona, thread, `refuse-${persona}`, { actor: 'moderator', action: 'moderation:takedown' }),
      [],
      false,
      true,
    );
    expect(await d().observe(thread)).toEqual(before);
  }
  await denied(await d().erase('unrelated', thread, 'author', 'refuse-erasure'));
  expect(await d().observe(thread)).toEqual(before);
  await ok(await d().read('anonymous', thread));
});

test('moderator denial and revocation precede receipt replay and expose no stored response', async () => {
  for (const mode of ['deny', 'revoke'] as const) {
    const { thread } = await fixture(`replay-${mode}`);
    const accepted = await ok(await d().takedown('moderator', thread, 'replay-key'));
    const once = await d().observe(thread);
    await d().setModeration('moderator', thread, mode);
    await denied(await d().takedown('moderator', thread, 'replay-key'), [
      JSON.stringify(accepted),
      '"securityRevision"',
    ]);
    await denied(await d().takedown('moderator', thread, 'fresh-denied-key'));
    expect(await d().observe(thread)).toEqual(once);
  }
});

test('reports persist with their own anchor exact target evidence and idempotency without hiding content', async () => {
  const { thread } = await fixture();
  const old = thread.revision;
  await d().edit(thread, 'report-new-revision');
  const before = await d().observe(thread);
  const input = { target: thread, revisionId: old.id, evidence: 'exact-report-evidence', key: 'one-report' };
  const receipt = await ok(await d().report('author', input));
  expect(await ok(await d().report('author', input))).toEqual(receipt);
  const after = await d().observe(thread);
  expect(after.reports).toHaveLength(before.reports.length + 1);
  const report = after.reports.find((r) => r.id === receipt.reportId)!;
  expect(report).toMatchObject({
    target: { kind: thread.kind, id: thread.id },
    revisionId: old.id,
    evidence: input.evidence,
  });
  expect(report.anchorId).toBeTruthy();
  expect(report.anchorId).not.toBe(thread.id);
  expect(after.effects.filter((e) => e.kind === 'report')).toHaveLength(1);
  expect(after.effects.find((e) => e.kind === 'report')).toMatchObject({
    partition: report.partition,
    transactionId: report.transactionId,
  });
  expect(after.visibility).toBe(before.visibility);
  expect(after.securityRevision).toBe(before.securityRevision);
  expect(after.revisions).toEqual(before.revisions);
  await ok(await d().read('anonymous', thread));
  expect(await ok(await d().inspectReports('moderator', thread))).toContainEqual(report);
  await d().setModeration('moderator', thread, 'revoke');
  await denied(await d().inspectReports('moderator', thread), [input.evidence, receipt.reportId], true);
  for (const persona of ['anonymous', 'author', 'unrelated'] as const) {
    await denied(await d().inspectReports(persona, thread), [input.evidence, receipt.reportId], true);
  }
});

test('anonymous reports require trusted Turnstile verification and reject caller verified assertions', async () => {
  const { thread } = await fixture();
  const before = await d().observe(thread);
  const key = randomUUID();
  for (const evidence of [
    {},
    { verified: true },
    { botToken: 'invalid-bot-token' },
    { botToken: 'invalid-bot-token', verified: true },
  ]) {
    const response = await d().report('anonymous', {
      target: thread,
      key,
      ...evidence,
    });
    expect([400, 403]).toContain(response.response.status);
    expect(response.value).toBeUndefined();
    expect(await d().observe(thread)).toEqual(before);
  }
  const botToken = await d().verifiedBotToken();
  const receipt = await ok(await d().report('anonymous', { target: thread, key, botToken }));
  expect((await d().observe(thread)).reports.map((r) => r.id)).toEqual([receipt.reportId]);
  await ok(await d().read('anonymous', thread));
});

test('anonymous report keys reject missing malformed and non-v4 UUIDs before anchoring a report', async () => {
  const { thread } = await fixture();
  const before = await d().observe(thread);
  for (const key of [
    undefined,
    '',
    'bot-report',
    '00000000-0000-0000-0000-000000000000',
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    '550e8400-e29b-41d4-0716-446655440000',
  ]) {
    const response = await d().report('anonymous', {
      target: thread,
      ...(key === undefined ? {} : { key }),
      botToken: await d().verifiedBotToken(),
    });
    await problem(response, 'invalid_request', true);
    expect(await d().observe(thread)).toEqual(before);
  }
  const receipt = await ok(
    await d().report('anonymous', {
      target: thread,
      key: randomUUID(),
      botToken: await d().verifiedBotToken(),
    }),
  );
  const after = await d().observe(thread);
  expect(after.reports.map((r) => r.id)).toEqual([receipt.reportId]);
  expect(after.reports[0]!.anchorId).toBeTruthy();
  expect(after.effects.filter((e) => e.kind === 'report')).toHaveLength(1);
});

test('anonymous reports use UUIDv4 possession keys with matching digest replay and conflict', async () => {
  const { thread } = await fixture();
  const input = {
    target: thread,
    revisionId: thread.revision.id,
    evidence: 'anonymous-exact-evidence',
    key: randomUUID(),
  };
  const receipt = await ok(await d().report('anonymous', { ...input, botToken: await d().verifiedBotToken() }));
  const once = await d().observe(thread);
  expect(once.reports).toHaveLength(1);
  const report = once.reports[0]!;
  expect(report).toMatchObject({
    id: receipt.reportId,
    target: { kind: thread.kind, id: thread.id },
    revisionId: input.revisionId,
    evidence: input.evidence,
  });
  expect(report.anchorId).toBeTruthy();
  expect(report.anchorId).not.toBe(thread.id);
  expect(once.effects.filter((e) => e.kind === 'report')).toHaveLength(1);
  expect(once.effects.find((e) => e.kind === 'report')).toMatchObject({
    partition: report.partition,
    transactionId: report.transactionId,
  });
  expect(await ok(await d().report('anonymous', { ...input, botToken: await d().verifiedBotToken() }))).toEqual(
    receipt,
  );
  expect(await d().observe(thread)).toEqual(once);
  const conflict = await d().report('anonymous', {
    ...input,
    evidence: 'changed-anonymous-evidence',
    botToken: await d().verifiedBotToken(),
  });
  await problem(conflict, 'idempotency_conflict');
  for (const secret of [receipt.reportId, input.evidence]) expect(await wire(conflict)).not.toContain(secret);
  expect(await d().observe(thread)).toEqual(once);
});

test('revoked public eligibility denies replay before stored report disclosure', async () => {
  for (const eligibility of ['protected', 'missing'] as const) {
    const { board, thread } = await fixture();
    const input = {
      target: thread,
      revisionId: thread.revision.id,
      evidence: `private-report-${eligibility}`,
      key: randomUUID(),
    };
    const receipt = await ok(await d().report('anonymous', { ...input, botToken: await d().verifiedBotToken() }));
    const once = await d().observe(thread);
    expect(once.visibility).toBe('public');
    expect(once.reports).toHaveLength(1);
    expect(once.reports[0]).toMatchObject({ id: receipt.reportId, evidence: input.evidence });
    expect(once.effects.filter((e) => e.kind === 'report')).toHaveLength(1);
    if (eligibility === 'protected') await d().protect(thread);
    else await d().failContainer(board, 'missing');
    const revoked = await d().observe(thread);
    expect(revoked.visibility).toBe(eligibility === 'protected' ? 'protected' : 'public');
    expect(revoked.reports).toEqual(once.reports);
    expect(revoked.effects).toEqual(once.effects);
    const replay = await d().report('anonymous', { ...input, botToken: await d().verifiedBotToken() });
    await denied(replay, [receipt.reportId, input.evidence]);
    expect(await d().observe(thread)).toEqual(revoked);
  }
});

test('authorized erasure nulls every authored revision and exact references remain erased without substituted bytes', async () => {
  const { board, thread } = await fixture('erase-sentinel-original');
  const second = await d().edit(thread, 'erase-sentinel-edited');
  const reply = await d().publish({ board, thread, body: 'erase-sentinel-reply' });
  await d().edit(reply, 'erase-sentinel-reply-edited');
  const other = await d().publish({ board, thread, author: 'unrelated', body: 'unrelated-retained' });
  await d().protect(thread);
  await d().grantRead('author', thread);
  await d().grantRead('author', reply);
  await d().projection('drain');
  const before = [await d().observe(thread), await d().observe(reply)];
  expect(before[0]!.revisions.map((r) => r.id)).toContain(second.id);
  expect(before.every((row) => row.revisions.length >= 2)).toBe(true);
  const otherBefore = await d().observe(other);
  await ok(await d().erase('author', thread, 'author', 'erase-all-authored'));
  for (const [index, target] of [thread, reply].entries()) {
    const after = await d().observe(target);
    expect(after.revisions).toHaveLength(before[index]!.revisions.length);
    for (const old of before[index]!.revisions) {
      expect(after.revisions.find((r) => r.id === old.id)).toEqual({
        ...old,
        body: null,
        hash: null,
        availability: 'erased',
      });
      const response = await d().read('author', target, old.id);
      expect((await ok(response)).revision).toEqual({ ...old, body: null, hash: null, availability: 'erased' });
      for (const row of before)
        for (const revision of row.revisions) expect(await wire(response)).not.toContain(revision.body!);
    }
    for (const persona of ['anonymous', 'unrelated'] as const) {
      await hidden(persona, target);
      for (const old of before[index]!.revisions) await problem(await d().read(persona, target, old.id), 'not_found');
    }
  }
  expect(await d().observe(other)).toEqual(otherBefore);
  const erased = await d().observe(thread);
  // The erasure workflow commits in bounded pages, each with its own event in the thread's partition.
  const erasures = erased.effects.filter((e) => e.kind === 'erasure');
  expect(erasures.length).toBeGreaterThan(0);
  for (const effect of erasures) expect(effect.partition).toBe(thread.partition);
  await ok(await d().erase('author', thread, 'author', 'erase-all-authored'));
  expect(await d().observe(thread)).toEqual(erased);
  await d().projection('drain');
  await d().projection('replay');
  const page = await d().list('author', board, { limit: 10 });
  await ok(page);
  for (const row of before)
    for (const old of row.revisions) {
      expect(await wire(page)).not.toContain(old.body!);
    }
  await ok(await d().takedown('moderator', thread, 'hide-erased'));
  for (const old of before[0]!.revisions) {
    const exact = await ok(await d().read('author', thread, old.id));
    expect(exact.revision).toEqual({ ...old, body: null, hash: null, availability: 'erased' });
    await problem(await d().read('anonymous', thread, old.id), 'not_found');
  }
});

async function receiptFixture() {
  const board = await d().board();
  const createKey = randomUUID();
  const editKey = randomUUID();
  const originalBody = 'receipt-create-erasure-sentinel';
  const editedBody = 'receipt-edit-erasure-sentinel';
  const thread = await d().publish({ board, body: originalBody, key: createKey });
  expect(thread.revision.body).toBe(originalBody);
  const edited = await d().edit(thread, editedBody, editKey);
  expect(edited.body).toBe(editedBody);
  expect(edited.id).not.toBe(thread.revision.id);
  await d().protect(thread);
  await d().grantRead('author', thread);
  // Keep the real parent creation and owner read/edit grants throughout erasure.
  for (const revision of [thread.revision, edited]) {
    expect(await ok(await d().read('author', thread, revision.id))).toEqual({ id: thread.id, revision });
  }
  return { board, thread, edited, createKey, editKey, bodies: [originalBody, editedBody] };
}

async function minimizedCopies(thread: Content, revisionIds: string[], bodies: string[]) {
  const copies = await d().inspectCommandCopies(thread);
  for (const payloads of [copies.receipts, copies.events]) {
    expect(payloads.length).toBeGreaterThan(0);
    const json = JSON.stringify(payloads);
    // These sentinels are the complete authored documents and their search text.
    for (const body of bodies) expect(json).not.toContain(body);
    expect(json).toContain(thread.id);
    for (const id of revisionIds) expect(json).toContain(id);
  }
}

test('durable receipts and outbox do not retain authored text copies', async () => {
  const { thread, edited, bodies } = await receiptFixture();
  const revisions = [thread.revision.id, edited.id];
  // Inspect while storage still has bytes: erasure must not be doing receipt cleanup.
  await minimizedCopies(thread, revisions, bodies);
  await ok(await d().erase('author', thread, 'author', 'erase-durable-copies'));
  await minimizedCopies(thread, revisions, bodies);
});

test('authorized create and revision replay cannot recover erased bytes from receipts', async () => {
  const { board, thread, edited, createKey, editKey, bodies } = await receiptFixture();
  const commands = [
    { key: createKey, revision: thread.revision },
    { key: editKey, revision: edited },
  ];
  await minimizedCopies(
    thread,
    commands.map(({ revision }) => revision.id),
    bodies,
  );
  const beforeReplay = await d().observe(thread);
  const originalCopies = await d().inspectCommandCopies(thread);
  const statuses: number[] = [];
  for (const { key, revision } of commands) {
    const response = await d().replayCommand(key);
    statuses.push(response.response.status);
    expect(await ok(response)).toEqual({ id: thread.id, revision });
    expect(await wire(response)).toContain(revision.body!);
  }
  expect(await d().observe(thread)).toEqual(beforeReplay);
  expect(await d().inspectCommandCopies(thread)).toEqual(originalCopies);
  await d().projection('drain');
  await ok(await d().erase('author', thread, 'author', 'erase-authorized-replay'));
  const erased = await d().observe(thread);
  const erasedCopies = await d().inspectCommandCopies(thread);
  expect(erased.revisions).toHaveLength(beforeReplay.revisions.length);
  expect(erased.effects.some((effect) => effect.kind === 'erasure')).toBe(true);
  for (const [index, { key, revision }] of commands.entries()) {
    const tombstone = { ...revision, body: null, hash: null, availability: 'erased' as const };
    expect(erased.revisions.find((row) => row.id === revision.id)).toEqual(tombstone);
    const response = await d().replayCommand(key);
    expect(response.response.status).toBe(statuses[index]!);
    expect(await ok(response)).toEqual({ id: thread.id, revision: tombstone });
    const exact = await d().read('author', thread, revision.id);
    expect(await ok(exact)).toEqual({ id: thread.id, revision: tombstone });
    // Replaying creation must not move the current revision back to the original.
    const current = await d().read('author', thread);
    expect(await ok(current)).toEqual({
      id: thread.id,
      revision: { ...edited, body: null, hash: null, availability: 'erased' },
    });
    for (const body of bodies) {
      expect(await wire(response)).not.toContain(body);
      expect(await wire(exact)).not.toContain(body);
      expect(await wire(current)).not.toContain(body);
    }
    expect(await d().observe(thread)).toEqual(erased);
    expect(await d().inspectCommandCopies(thread)).toEqual(erasedCopies);
  }
  await minimizedCopies(
    thread,
    commands.map(({ revision }) => revision.id),
    bodies,
  );
  await d().projection('drain');
  await d().projection('replay');
  const page = await d().list('author', board, { limit: 10 });
  await ok(page);
  for (const body of bodies) {
    expect(await wire(page)).not.toContain(body);
  }
  await minimizedCopies(
    thread,
    commands.map(({ revision }) => revision.id),
    bodies,
  );
});
