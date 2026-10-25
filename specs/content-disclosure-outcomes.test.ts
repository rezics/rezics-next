import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
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
async function problem(reply: Reply<unknown>, code: 'not_found' | 'invalid_request' | 'forbidden') {
  const status = { not_found: 404, invalid_request: 400, forbidden: 403 }[code];
  expect(reply.response.status).toBe(status);
  expect(reply.response.headers.get('content-type')).toContain('application/problem+json');
  expect(reply.value).toBeUndefined();
  const body = await reply.response.clone().json();
  expect(body).toMatchObject({
    type: `https://rezics.com/problems/${code}`,
    code,
    status,
    retryable: false,
    effect_status: code === 'forbidden' ? 'not_applied' : 'not_applicable',
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
    await denied(await d().takedown('moderator', thread, 'replay-key'), [accepted.securityRevision]);
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
  for (const evidence of [
    {},
    { verified: true },
    { botToken: 'invalid-bot-token' },
    { botToken: 'invalid-bot-token', verified: true },
  ]) {
    const response = await d().report('anonymous', {
      target: thread,
      key: 'bot-report',
      ...evidence,
    });
    expect([400, 403]).toContain(response.response.status);
    expect(response.value).toBeUndefined();
    expect(await d().observe(thread)).toEqual(before);
  }
  const botToken = await d().verifiedBotToken();
  const receipt = await ok(await d().report('anonymous', { target: thread, key: 'bot-report', botToken }));
  expect((await d().observe(thread)).reports.map((r) => r.id)).toEqual([receipt.reportId]);
  await ok(await d().read('anonymous', thread));
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
  expect((await ok(await d().search('author', 'erase-sentinel'))).items.map((t) => t.id)).toContain(thread.id);
  const before = [await d().observe(thread), await d().observe(reply)];
  expect(before[0]!.revisions.map((r) => r.id)).toContain(second.id);
  expect(before.every((row) => row.revisions.length >= 2)).toBe(true);
  const otherBefore = await d().observe(other);
  await ok(await d().erase('author', thread, 'author', 'erase-all-authored'));
  for (const [index, target] of [thread, reply].entries()) {
    const after = await d().observe(target);
    expect(after.revisions).toHaveLength(before[index]!.revisions.length);
    for (const old of before[index]!.revisions) {
      expect(after.revisions.find((r) => r.id === old.id)).toEqual({ ...old, body: null, availability: 'erased' });
      const response = await d().read('author', target, old.id);
      expect((await ok(response)).revision).toEqual({ ...old, body: null, availability: 'erased' });
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
  expect(erased.effects.filter((e) => e.kind === 'erasure')).toHaveLength(1);
  expect(erased.effects.find((e) => e.kind === 'erasure')?.partition).toBe(thread.partition);
  await ok(await d().erase('author', thread, 'author', 'erase-all-authored'));
  expect(await d().observe(thread)).toEqual(erased);
  await d().projection('drain');
  await d().projection('replay');
  // Use an authorized reader so absence cannot be explained by protection alone.
  const search = await d().search('author', 'erase-sentinel');
  expect((await ok(search)).items).toEqual([]);
  const page = await d().list('author', board, { limit: 10 });
  await ok(page);
  for (const row of before)
    for (const old of row.revisions) {
      expect(await wire(search)).not.toContain(old.body!);
      expect(await wire(page)).not.toContain(old.body!);
    }
  await ok(await d().takedown('moderator', thread, 'hide-erased'));
  for (const old of before[0]!.revisions) {
    const exact = await ok(await d().read('author', thread, old.id));
    expect(exact.revision).toEqual({ ...old, body: null, availability: 'erased' });
    await problem(await d().read('anonymous', thread, old.id), 'not_found');
  }
});
