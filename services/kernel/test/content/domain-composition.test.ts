import { expect, test } from 'bun:test';
import {
  CONTENT_DOCUMENT_BYTES,
  CONTENT_WORKER_STEP_MS,
  type ContentApplicationPorts,
  type ContentAuthoredFieldInput,
} from '../../src/content/contract/index.ts';
import { admitDocumentRead, lemmyActiveRank, normalizeBoardQuery } from '../../src/content/core/index.ts';
import { AuthoredFieldRejectedError, createContentApplication } from '../../src/content/application/index.ts';
import {
  bindContentApplication,
  tryContentApplication,
  unbindContentApplication,
} from '../../src/content/adapters/bind.ts';

const subject = '11111111-1111-4111-8111-111111111111';
const candidate = '22222222-2222-4222-8222-222222222222';

function fakePorts(overrides: Partial<ContentApplicationPorts> = {}): ContentApplicationPorts {
  let now = 1_000;
  const erased: { id: string; subject: string; authorId: string } | null = {
    id: subject,
    subject,
    authorId: candidate,
  };
  return {
    documents: {
      async read(_client, _route, id) {
        return id === subject ? { availability: 'available', origin: 'account', subject, candidate } : null;
      },
    },
    authoredFields: {
      async erase(id, deadline) {
        if (now >= deadline) return null;
        return id === subject ? erased : null;
      },
    },
    ranking: {
      async refreshBatch(_pool, _at, partitions) {
        return partitions.length;
      },
      async readRealmVotes() {
        return new Map();
      },
    },
    ambient: {
      clock: () => new Date('2020-01-01T00:00:00.000Z'),
      now: () => now,
      id: () => '33333333-3333-4333-8333-333333333333',
      fetch: async () => new Response(null, { status: 204 }),
    },
    ...overrides,
  };
}

const authored: ContentAuthoredFieldInput = {
  subject,
  candidate,
  revision: 1,
  language: 'en',
  document: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
};

test('Content application admits document reads from the supplied clock without touching storage', async () => {
  const application = createContentApplication(fakePorts());
  expect(application.admitsDocumentRead(1, 2_000)).toBe(true);
  expect(application.admitsDocumentRead(1, 500)).toBe(false);
  expect(application.admitsDocumentRead(null, 2_000)).toBe(false);
  expect(
    admitDocumentRead({
      route: 1,
      deadline: 2_000,
      now: 2_000,
      maxBytes: CONTENT_DOCUMENT_BYTES,
    }),
  ).toBe(false);
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  expect(await application.ports.documents.read(client, 1, subject)).toEqual({
    availability: 'available',
    origin: 'account',
    subject,
    candidate,
  });
});

test('Content application ranks, rejects media authored fields and budgets workers from ambient', async () => {
  const application = createContentApplication(fakePorts());
  expect(application.activeRank(10, new Date('2019-12-31T12:00:00.000Z'))).toBe(
    lemmyActiveRank(10, new Date('2019-12-31T12:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z')),
  );
  expect(application.normalizeBoardQuery('  hello  ')).toBe(normalizeBoardQuery('  hello  '));
  expect(application.nextAuthoredFieldId()).toBe('33333333-3333-4333-8333-333333333333');
  application.admitAuthoredField(authored);
  expect(() => application.admitAuthoredField({ ...authored, document: { type: 'image' } })).toThrow(
    AuthoredFieldRejectedError,
  );
  expect(application.workerStepDeadline()).toBe(1_000 + CONTENT_WORKER_STEP_MS);
  expect(await application.eraseAuthoredField(subject, 2_000)).toEqual({
    id: subject,
    subject,
    authorId: candidate,
  });
  expect(await application.eraseAuthoredField(subject, 500)).toBeNull();
});

test('bindContentApplication exposes the fake application to Content facades', () => {
  const application = createContentApplication(fakePorts());
  bindContentApplication(application);
  expect(tryContentApplication()).toBe(application);
  expect(tryContentApplication()?.ambient.now()).toBe(1_000);
  expect(tryContentApplication()?.ambient.id()).toBe('33333333-3333-4333-8333-333333333333');
  expect(tryContentApplication()?.workerStepDeadline()).toBe(1_000 + CONTENT_WORKER_STEP_MS);
  expect(tryContentApplication()?.requestContext(2_000, 'key')).toEqual({
    deadline: 2_000,
    requestId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'key',
  });
  unbindContentApplication();
  expect(tryContentApplication()).toBeUndefined();
});

test('publication withholds work after the supplied clock passes the deadline', async () => {
  const created: number[] = [];
  const application = createContentApplication(
    fakePorts({
      publication: {
        async createThread(deadline) {
          created.push(deadline);
          return { id: 'thread' };
        },
      },
    }),
  );
  expect(await application.createThread(2_000)).toEqual({ id: 'thread' });
  expect(await application.createThread(500)).toBeNull();
  expect(created).toEqual([2_000]);
});
