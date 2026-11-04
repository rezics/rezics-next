import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { libraryNavigation } from '../src/library/navigation';
import { createVndbJourney } from '../src/library/personal-list-import/controller';
import {
  VNDB_XML_BYTES,
  type VndbCommand,
  type VndbPort,
  type VndbReviewInput,
  type VndbRow,
} from '../src/library/personal-list-import/contract';
import { nativeVndbImport } from '../src/library/personal-list-import/native';
import { VndbEvidence } from '../src/library/personal-list-import/fields';
import type { VndbVisit } from '../src/library/personal-list-import/visit';

const uploadId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const reviewIds = ['0192f3a0-6c1e-7b2a-9d4e-00000000cccc', '0192f3a0-6c1e-7b2a-9d4e-00000000dddd'];

function visit(): VndbVisit {
  const controller = new AbortController();
  let retired = false;
  return {
    subject,
    csrfToken: 'captured-csrf',
    controller,
    retire() {
      retired = true;
      controller.abort();
    },
    current() {
      return !retired && !controller.signal.aborted;
    },
  };
}

function row(ordinal: number): VndbRow {
  return {
    ordinal,
    kind: 'vn',
    identifier: { provider: 'vndb', kind: 'vn', value: `v${ordinal + 1}` },
    title: `Novel ${ordinal + 1}`,
    labels: [],
    suggestedRole: null,
    fields: {},
    retainedReason: '',
    evidence: {},
    match: { status: 'unmatched', candidates: [] },
    target: null,
    decision: null,
    scoreDecision: null,
    consumptionDateReview: null,
    consumptionDateOutcome: null,
    nativeScore: {
      question: null,
      currentVote: { state: 'unavailable' },
      sourceReason: 'private source',
      exactUnits: null,
      admission: { status: 'unavailable', reason: 'native-question-unavailable' },
    },
    fieldsTreatment: { state: 'review', score: 'private source', other: 'retain' },
  };
}

function makePort(overrides: Partial<VndbPort> = {}): VndbPort {
  const unavailable = async () => ({ kind: 'unavailable' as const, status: 503 });
  return {
    preview: unavailable,
    page: unavailable,
    source: unavailable,
    review: unavailable,
    apply: unavailable,
    cancel: unavailable,
    delete: unavailable,
    ...overrides,
  };
}

function previewValue(rows: number) {
  return {
    uploadId,
    rows,
    limits: {
      bytes: VNDB_XML_BYTES,
      wireBytes: 12 * 1024 * 1024 + 64,
      depth: 32,
      rows: 5000,
      evidenceBytes: 16 * 1024 * 1024,
      page: 8,
      uploads: 4,
      lifetimeMs: 86_400_000,
      applyMs: 5000,
    },
  };
}

function pageValue(rows: VndbRow[]) {
  return {
    uploadId,
    state: 'active' as const,
    expiresAt: '2026-11-04T00:00:00Z',
    total: rows.length,
    next: null,
    rows,
  };
}

test('binds generated libraryImports.vndb and keeps the visit discoverable', () => {
  expect(nativeVndbImport(createKernelClient('http://example.invalid'))).toBeDefined();
  expect(nativeVndbImport({} as never)).toBeUndefined();
  expect(
    libraryNavigation.some((entry) => entry.id === 'library.import-vndb' && entry.href === '/library/import-vndb'),
  ).toBe(true);
});

test('keeps VNDB score precision visible without implying native vote consent or effects', () => {
  const scored = row(0);
  scored.fields.score = { kind: 'value', raw: '07.3', value: 7.3, scale: { min: 1, max: 10, step: 0.1 } };
  const html = renderToStaticMarkup(<VndbEvidence row={scored} />);
  expect(html).toContain('07.3');
  expect(html).toContain('Source score');
  expect(html).toContain('step 0.1');
  expect(html).toContain('no exact match on a native half-step scale');
  expect(html).toContain('separate explicit consent');
  expect(html).toContain('data-vndb-score-review="unavailable"');
  expect(html).not.toContain('<input');

  const zero = row(1);
  zero.fields.score = { kind: 'invalid', raw: '0' };
  const zeroHtml = renderToStaticMarkup(<VndbEvidence row={zero} />);
  expect(zeroHtml).toContain('source score of 0 is invalid');
  expect(zeroHtml).toContain('native vote of 0 is valid');
  zero.fields = { vote: zero.fields.score! };
  expect(renderToStaticMarkup(<VndbEvidence row={zero} />)).toContain('data-vndb-score-review="unavailable"');
});

test('sends XML to native admission without a browser size guard or local preview effects', async () => {
  const xml = 'x'.repeat(VNDB_XML_BYTES + 1);
  const sent: string[] = [];
  let applies = 0;
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async (command) => {
        sent.push(command.xml);
        return command.xml.length > VNDB_XML_BYTES
          ? { kind: 'admission', status: 400 }
          : { kind: 'wire-too-large', status: 413 };
      },
      apply: async () => {
        applies += 1;
        return { kind: 'unavailable', status: 503 };
      },
    }),
  });

  const snap = await journey.preview(xml);
  expect(sent).toEqual([xml]);
  expect(snap.notice).toEqual({ kind: 'admission', status: 400 });
  expect(snap.uploadId).toBeNull();
  expect(applies).toBe(0);

  const wire = await journey.preview('<vndb-export version="1.0"/>');
  expect(wire.notice).toEqual({ kind: 'wire-too-large', status: 413 });
  expect(wire.uploadId).toBeNull();
});

test('confirms only reviewed rows and retries an unknown apply with the identical command', async () => {
  const rows = [row(0)];
  const commands: Extract<VndbCommand, { kind: 'apply' }>[] = [];
  let attempts = 0;
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async () => ({ kind: 'previewed', value: previewValue(1) }),
      page: async () => ({ kind: 'page', value: pageValue(rows) }),
      review: async (command) => ({
        kind: 'reviewed',
        value: {
          reviewId: reviewIds[0]!,
          status: 'reviewed',
          targetId: command.body.action === 'state' ? command.body.targetId : null,
          state: command.body.action === 'state' ? command.body.state : null,
          baseline: null,
          replace: false,
          action: 'state',
        },
      }),
      apply: async (command) => {
        commands.push(command);
        attempts += 1;
        return attempts === 1
          ? { kind: 'unknown', command }
          : {
              kind: 'applied',
              value: {
                uploadId,
                outcomes: [{ ordinal: 0, reviewId: reviewIds[0]!, status: 'applied' }],
                stopped: null,
              },
            };
      },
    }),
  });

  await journey.preview('<vndb-export version="1.0"/>');
  expect(journey.snapshot().selection).toEqual([]);
  await journey.review({ ordinal: 0, action: 'state', targetId: subject, state: 'reading', replace: false });
  expect(journey.snapshot().selection.map((item) => item.ordinal)).toEqual([0]);
  expect(commands).toHaveLength(0);
  journey.openConfirm();
  await journey.confirm();
  expect(journey.snapshot().notice?.kind).toBe('unknown');
  await journey.retryUnknown();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(Object.isFrozen(commands[0]?.body.rows[0])).toBe(true);
  expect(journey.snapshot().outcomes.map(({ ordinal, status }) => [ordinal, status])).toEqual([[0, 'applied']]);
  expect(journey.snapshot().selection).toEqual([]);
});

test('keeps acknowledged outcomes and the remaining selection after native cancellation', async () => {
  const rows = [row(0), row(1)];
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async () => ({ kind: 'previewed', value: previewValue(2) }),
      page: async () => ({ kind: 'page', value: pageValue(rows) }),
      review: async (command) => ({
        kind: 'reviewed',
        value: {
          reviewId: reviewIds[command.body.ordinal]!,
          status: 'skipped',
          targetId: null,
          state: null,
          baseline: null,
          replace: false,
          action: 'state',
        },
      }),
      apply: async () => ({
        kind: 'applied',
        value: {
          uploadId,
          outcomes: [{ ordinal: 0, reviewId: reviewIds[0]!, status: 'skipped' }],
          stopped: 'cancelled',
        },
      }),
    }),
  });

  await journey.preview('<vndb-export version="1.0"/>');
  await journey.review({ ordinal: 0, action: 'skip' });
  await journey.review({ ordinal: 1, action: 'skip' });
  journey.openConfirm();
  const snap = await journey.confirm();
  expect(snap.cancelled).toBe(true);
  expect(snap.outcomes.map((outcome) => outcome.ordinal)).toEqual([0]);
  expect(snap.selection.map((item) => item.ordinal)).toEqual([1]);
  expect(snap.unattempted).toEqual([1]);
});

test.each(['retire', 'subject', 'csrfToken'] as const)(
  '%s replacement retires private source and late page reads',
  async (change) => {
    const current = visit();
    let pages = 0;
    const late = Promise.withResolvers<{ kind: 'page'; value: ReturnType<typeof pageValue> }>();
    const journey = createVndbJourney({
      visit: current,
      port: makePort({
        preview: async () => ({ kind: 'previewed', value: previewValue(1) }),
        page: async () => {
          pages += 1;
          if (pages === 2) return late.promise;
          return { kind: 'page', value: pageValue([row(0)]) };
        },
        source: async () => ({ kind: 'source', xml: '<private-source/>' }),
      }),
    });

    await journey.preview('<vndb-export version="1.0"/>');
    expect(pages).toBe(1);
    expect(journey.snapshot().rows.map((item) => item.title)).toEqual(['Novel 1']);
    await journey.source();
    const loading = journey.loadPage(0);
    if (change === 'retire') {
      current.retire();
      journey.retire();
    } else {
      const previous = current[change];
      current[change] = 'replacement';
      expect(journey.snapshot().sourceXML).toBeNull();
      current[change] = previous;
    }
    late.resolve({ kind: 'page', value: pageValue([row(1)]) });
    await loading;
    await journey.loadPage(0);
    expect(pages).toBe(2);
    expect(journey.live()).toBe(false);
    expect(journey.snapshot()).toMatchObject({ uploadId: null, rows: [], selection: [], page: null, sourceXML: null });
  },
);

test.each(['denied', 'unknown'] as const)('source replacement retires review before %s cleanup', async (kind) => {
  const cleanup = Promise.withResolvers<Awaited<ReturnType<VndbPort['delete']>>>();
  const deletes: VndbCommand[] = [];
  const previews: string[] = [];
  const selected = row(0);
  selected.decision = {
    reviewId: reviewIds[0]!,
    status: 'skipped',
    targetId: null,
    state: null,
    baseline: null,
    replace: false,
    action: 'state',
  };
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async (command) => {
        previews.push(command.xml);
        return { kind: 'previewed', value: previewValue(1) };
      },
      page: async () => ({ kind: 'page', value: pageValue([selected]) }),
      source: async () => ({ kind: 'source', xml: '<private-source/>' }),
      delete: async (command) => {
        deletes.push(command);
        return deletes.length === 1 ? cleanup.promise : { kind: 'deleted' };
      },
    }),
  });
  await journey.preview('<original/>');
  await journey.source();
  expect(journey.openConfirm().stage).toBe('confirm');
  const replacing = journey.preview('<replacement/>');
  expect(journey.snapshot()).toMatchObject({ stage: 'upload', sourceXML: null, rows: [], selection: [], page: null });
  cleanup.resolve(kind === 'denied' ? { kind, status: 403 } : { kind, command: deletes[0]! });
  await replacing;
  await journey.loadPage(0);
  await journey.source();
  await journey.confirm();
  expect(journey.snapshot()).toMatchObject({ sourceXML: null, rows: [], selection: [], outcomes: [] });
  expect(previews).toEqual(['<original/>']);
  await journey.retryUnknown();
  expect(deletes[1]).toBe(deletes[0]);
  expect(previews).toEqual(['<original/>', '<replacement/>']);
});

test('a lost review acknowledgement freezes its body and key and a new review needs confirmation again', async () => {
  const commands: Extract<VndbCommand, { kind: 'review' }>[] = [];
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async () => ({ kind: 'previewed', value: previewValue(1) }),
      page: async () => ({ kind: 'page', value: pageValue([row(0)]) }),
      review: async (command) => {
        commands.push(command);
        if (commands.length === 4) return { kind: 'denied', status: 403 };
        return commands.length === 1
          ? { kind: 'unknown', command }
          : {
              kind: 'reviewed',
              value: {
                reviewId: reviewIds[0]!,
                status: 'reviewed',
                targetId: subject,
                state: command.body.action === 'state' ? command.body.state : null,
                baseline: null,
                replace: false,
                action: 'state',
              },
            };
      },
    }),
  });
  await journey.preview('<vndb-export version="1.0"/>');
  const body: VndbReviewInput = { ordinal: 0, action: 'state', targetId: subject, state: 'reading', replace: false };
  await journey.review(body);
  body.state = 'completed';
  journey.openConfirm();
  expect(journey.snapshot().stage).toBe('review');
  await journey.retryUnknown();
  expect(commands[1]).toBe(commands[0]);
  expect(commands[1]?.body).toMatchObject({ state: 'reading' });
  journey.openConfirm();
  await journey.review(body);
  expect(commands[2]?.key).not.toBe(commands[0]?.key);
  expect(journey.snapshot().stage).toBe('review');
  await journey.confirm();
  expect(journey.snapshot().outcomes).toEqual([]);
  journey.openConfirm();
  expect(journey.snapshot().stage).toBe('confirm');
  await journey.review(body);
  expect(journey.snapshot().notice).toEqual({ kind: 'denied', status: 403 });
  expect(journey.snapshot().stage).toBe('review');
  expect(journey.snapshot().selection).toEqual([]);
  await journey.confirm();
  expect(journey.snapshot().outcomes).toEqual([]);
  await journey.loadPage(0);
  expect(journey.snapshot().selection).toEqual([]);
});

test('the installed generated VNDB methods send state review and apply without vote operands', async () => {
  const sent: { path: string; body: unknown }[] = [];
  const route = nativeVndbImport(
    createKernelClient('http://example.invalid', {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          sent.push({ path: new URL(request.url).pathname, body: await request.json() });
          return Response.json({});
        },
        { preconnect: fetch.preconnect },
      ),
    }),
  );
  await route!({ uploadId }).$review.post(
    { ordinal: 0, action: 'state', targetId: subject, state: 'reading', replace: false },
    { headers: { 'idempotency-key': JSON.stringify(reviewIds[0]) } },
  );
  await route!({ uploadId }).$apply.post({ rows: [{ ordinal: 0, reviewId: reviewIds[0]! }] });
  expect(sent).toEqual([
    {
      path: `/v1/libraryImports/vndb/${uploadId}:review`,
      body: { ordinal: 0, action: 'state', targetId: subject, state: 'reading', replace: false },
    },
    { path: `/v1/libraryImports/vndb/${uploadId}:apply`, body: { rows: [{ ordinal: 0, reviewId: reviewIds[0] }] } },
  ]);
});

test('Library page reads never replay an uncertain import; its original command survives browsing until visit retirement', async () => {
  const { createImportLibraryBrowser } = await import('../src/library/showcase-import-return/browser');
  const current = visit();
  const commands: VndbCommand[] = [];
  const journey = createVndbJourney({ visit: current, port: makePort({
    preview: async () => ({ kind: 'previewed', value: previewValue(1) }),
    page: async () => ({ kind: 'page', value: pageValue([row(0)]) }),
    review: async (command) => ({ kind: 'reviewed', value: {
      reviewId: reviewIds[0]!, status: 'skipped', targetId: null, state: null, baseline: null, replace: false, action: 'state',
    } }),
    apply: async (command) => { commands.push(command); return { kind: 'unknown', command }; },
  }) });
  await journey.preview('<vndb-export version="1.0"/>');
  await journey.review({ ordinal: 0, action: 'skip' });
  journey.openConfirm();
  await journey.confirm();
  const original = commands[0];
  const browser = createImportLibraryBrowser({ current: current.current, read: async () => ({
    state: 'current', page: { libraryEntries: [], next: null },
  }) });
  await browser.first();
  await browser.refresh();
  await browser.restart();
  expect(commands).toHaveLength(1);
  expect(journey.snapshot().retryCommand).toBe('apply');
  await journey.retryUnknown();
  expect(commands[1]).toBe(original);
  current.retire();
  expect(browser.current()).toBe(false);
  await journey.retryUnknown();
  expect(commands).toHaveLength(2);
  expect(browser.snapshot().visible).toBeNull();
});
