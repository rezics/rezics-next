import { expect, test } from 'bun:test';
import { createVndbJourney } from '../src/library/personal-list-import/controller';
import {
  VNDB_XML_BYTES,
  type VndbCommand,
  type VndbPort,
  type VndbRow,
} from '../src/library/personal-list-import/contract';
import type { VndbVisit } from '../src/library/personal-list-import/visit';

const uploadId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const reviewIds = ['0192f3a0-6c1e-7b2a-9d4e-00000000cccc', '0192f3a0-6c1e-7b2a-9d4e-00000000dddd'];

function visit(): VndbVisit {
  return { subject, csrfToken: 'captured-csrf', controller: new AbortController(), current: () => true, retire() {} };
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
    fieldsTreatment: { state: 'review', other: 'retain' },
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

test('sends XML to native admission without a browser size guard or local preview effects', async () => {
  const xml = 'x'.repeat(VNDB_XML_BYTES + 1);
  const sent: string[] = [];
  let applies = 0;
  const journey = createVndbJourney({
    visit: visit(),
    port: makePort({
      preview: async (command) => {
        sent.push(command.xml);
        return { kind: 'admission', status: 400 };
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
  await journey.review({ ordinal: 0, action: 'state', targetId: subject, state: 'reading', replace: false });
  expect(journey.snapshot().selection.map((item) => item.ordinal)).toEqual([0]);
  expect(commands).toHaveLength(0);
  journey.openConfirm();
  await journey.confirm();
  expect(journey.snapshot().notice?.kind).toBe('unknown');
  await journey.retryUnknown();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
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
