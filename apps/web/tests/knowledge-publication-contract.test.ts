import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { selectKnowledgePublication, type KnowledgePublicationCommand } from '../src/knowledge/publication';

const documentId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const publicationId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const command: KnowledgePublicationCommand = {
  documentId,
  expectedHeadRevisionId: revisionId,
  expectedPublicationId: null,
  revisionId,
  idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  authorization: 'Bearer captured-original-credential',
};

function boundary(respond: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => respond(new Request(input, init))) as typeof fetch,
  });
}

test('generated singular publication selection sends exact CAS operands, captured credential and immutable key', async () => {
  const requests: Request[] = [];
  const client = boundary(async (request) => {
    requests.push(request.clone());
    expect(new URL(request.url).pathname).toBe(`/v1/knowledge/documents/${documentId}/publication:select`);
    expect(request.method).toBe('POST');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBe(command.authorization);
    expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
    const body = await request.json();
    expect(Object.keys(body).sort()).toEqual(['expectedHeadRevisionId', 'expectedPublicationId', 'revisionId']);
    return Response.json(
      body.revisionId === null ? { documentId, publicationId: null } : { documentId, publicationId, revisionId },
    );
  });
  expect(await selectKnowledgePublication(client, command)).toEqual({
    state: 'acknowledged',
    receipt: { documentId, publicationId, revisionId },
  });
  const withdrawal = { ...command, expectedPublicationId: publicationId, revisionId: null };
  expect(await selectKnowledgePublication(client, withdrawal)).toEqual({
    state: 'acknowledged',
    receipt: { documentId, publicationId: null, revisionId: null },
  });
  expect(await requests[0]!.json()).toEqual({
    expectedHeadRevisionId: revisionId,
    expectedPublicationId: null,
    revisionId,
  });
  expect(await requests[1]!.json()).toEqual({
    expectedHeadRevisionId: revisionId,
    expectedPublicationId: publicationId,
    revisionId: null,
  });
});

test('publication HTTP failures preserve conflict and unknown outcomes; malformed acknowledgements cannot create links', async () => {
  for (const [status, state] of [
    [401, 'denied'],
    [403, 'denied'],
    [404, 'not-found'],
    [412, 'conflict'],
    [422, 'unavailable'],
    [503, 'uncertain'],
  ] as const) {
    const result = await selectKnowledgePublication(
      boundary(() => Response.json({ status }, { status })),
      command,
    );
    expect(result.state).toBe(state);
  }
  for (const response of [
    {},
    { documentId, publicationId },
    { documentId, publicationId: null, revisionId },
    { documentId: revisionId, publicationId, revisionId },
    { documentId, publicationId: 'not-a-native-id', revisionId },
    { documentId, publicationId, revisionId: documentId },
  ]) {
    expect(
      await selectKnowledgePublication(
        boundary(() => Response.json(response)),
        command,
      ),
    ).toEqual({ state: 'uncertain' });
  }
  expect(
    await selectKnowledgePublication(
      boundary(() => Response.json({ documentId, publicationId })),
      { ...command, revisionId: null },
    ),
  ).toEqual({ state: 'uncertain' });
});
