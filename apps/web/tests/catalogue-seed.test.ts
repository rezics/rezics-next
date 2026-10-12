import { describe, expect, spyOn, test } from 'bun:test';
import { appendCatalogueParts, createCatalogueWork } from './g-838-catalogue.ts';
import { catalogueCommandResult, settledCatalogueSend } from './g-837-catalogue.ts';

const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-7000-8000-000000000002';
const parts = [{ work: 'https://rezics.com/id/00000000-0000-7000-8000-000000000003', label: '1' }];
const conflict = (code = 'read_basis_changed') => Response.json({ code }, { status: 409 });

describe('catalogue seed pending commands', () => {
  test('accepts the replayed creation receipt after observing its pending operation', async () => {
    const keys: (string | undefined)[] = [];
    const send = settledCatalogueSend(async (_method, _path, _body, key) => {
      keys.push(key);
      return keys.length === 1
        ? Response.json({ operationId: 'creation', retry: { afterMs: 0 } }, { status: 202 })
        : Response.json({ structure, revision: 'saved', replayed: true });
    });
    const response = await send('POST', '/v1/compositions', { actor }, 'creation-key');
    expect(
      await catalogueCommandResult<{ structure: string; revision: string; replayed: boolean }>(
        response,
        201,
      ),
    ).toEqual({
      structure,
      revision: 'saved',
      replayed: true,
    });
    expect(keys).toEqual(['creation-key', 'creation-key']);
  });

  test('a creation receipt still rejects an unmarked 200 or a terminal refusal', async () => {
    for (const [status, body] of [
      [200, { revision: 'saved' }],
      [200, { replayed: false }],
      [200, { detail: '\"replayed\":true' }],
      [403, { replayed: true }],
      [409, { replayed: true }],
    ] as const) {
      await expect(catalogueCommandResult(Response.json(body, { status }), 201)).rejects.toThrow(
        `Expected 201, got ${status}`,
      );
    }
  });

  for (const explicitKey of [undefined, 'saved-command']) {
    test(`observes a reconciling composition with the same body and ${explicitKey ? 'saved' : 'generated'} key`, async () => {
      const body = { expectedHead: 'head', operations: [{ op: 'completion' }] };
      const calls: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
      const send = settledCatalogueSend(async (method, path, value, key) => {
        calls.push({ method, path, body: value, key });
        return calls.length < 3
          ? Response.json(
              {
                operationId: 'same-operation',
                status: 'reconciling',
                retry: { allowed: true, afterMs: 0 },
              },
              { status: 202 },
            )
          : Response.json({ revision: 'saved', replayed: true });
      });
      const response = await send('POST', '/v1/compositions/structure/changes', body, explicitKey);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revision: 'saved', replayed: true });
      expect(calls).toHaveLength(3);
      expect(calls[0]!.key).toBeString();
      if (explicitKey) expect(calls[0]!.key).toBe(explicitKey);
      expect(
        calls.every(
          (call) =>
            call.method === 'POST' &&
            call.path === '/v1/compositions/structure/changes' &&
            call.body === body &&
            call.key === calls[0]!.key,
        ),
      ).toBe(true);
    });
  }

  test('returns a terminal refusal without starting another command', async () => {
    const calls: (string | undefined)[] = [];
    const send = settledCatalogueSend(async (_method, _path, _body, key) => {
      calls.push(key);
      return calls.length === 1
        ? Response.json({ operationId: 'same-operation', retry: { afterMs: 0 } }, { status: 202 })
        : Response.json({ code: 'read_basis_changed' }, { status: 409 });
    });
    const response = await send('POST', '/v1/compositions/structure/changes', {}, 'original-key');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'read_basis_changed' });
    expect(calls).toEqual(['original-key', 'original-key']);
  });
});

describe('catalogue seed composition recovery', () => {
  test('rereads the head and reapplies the ordered part intent with a fresh key', async () => {
    const events: string[] = [];
    const writes: { body: unknown; key: string | undefined }[] = [];
    await appendCatalogueParts(
      {
        actor,
        read: async (path) => {
          events.push(`GET ${path}`);
          return Response.json({ structure, revision: `head-${writes.length}` });
        },
        send: async (method, path, body, key) => {
          events.push(`${method} ${path}`);
          writes.push({ body, key });
          return writes.length === 1 ? conflict() : Response.json({ revision: 'saved' });
        },
      },
      structure,
      parts,
    );
    expect(events.map((event) => event.split(' ')[0])).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(events[0]).toBe(`GET /v1/compositions/${structure.slice(-36)}`);
    expect(writes.map((write) => (write.body as { expectedHead: string }).expectedHead)).toEqual([
      'head-0',
      'head-1',
    ]);
    expect(writes[0]!.key).toBeString();
    expect(writes[1]!.key).toBeString();
    expect(writes[0]!.key).not.toBe(writes[1]!.key);
    for (const write of writes)
      expect(write.body).toMatchObject({
        profile: 'work-composition',
        actingSubject: actor,
        operations: [
          {
            op: 'insert',
            parent: structure,
            position: 'last',
            role: 'part',
            target: parts[0]!.work,
            displayLabel: '1',
            inclusion: 'required',
          },
        ],
      });
  });

  test('restarts a stale read before sending any edit', async () => {
    let reads = 0;
    let writes = 0;
    await appendCatalogueParts(
      {
        actor,
        read: async () =>
          ++reads === 1 ? conflict() : Response.json({ structure, revision: 'current' }),
        send: async () => {
          writes++;
          return Response.json({ revision: 'saved' });
        },
      },
      structure,
      parts,
    );
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  test('observes an available head without scheduling a relay delay', async () => {
    const delay = spyOn(globalThis, 'setTimeout');
    let reads = 0;
    const writes: unknown[] = [];
    try {
      await appendCatalogueParts(
        {
          actor,
          read: async () =>
            ++reads < 4 ? conflict() : Response.json({ structure, revision: 'visible-head' }),
          send: async (_method, _path, body) => {
            writes.push(body);
            return Response.json({ revision: 'saved' });
          },
        },
        structure,
        parts,
      );
      expect(reads).toBe(4);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ expectedHead: 'visible-head' });
      expect(delay).not.toHaveBeenCalled();
    } finally {
      delay.mockRestore();
    }
  });

  test('bounds unavailable-head reads without sending an edit', async () => {
    let reads = 0;
    let writes = 0;
    await expect(
      appendCatalogueParts(
        {
          actor,
          read: async () => {
            reads++;
            return conflict();
          },
          send: async () => {
            writes++;
            return Response.json({});
          },
        },
        structure,
        parts,
      ),
    ).rejects.toThrow('read_basis_changed');
    expect(reads).toBe(4);
    expect(writes).toBe(0);
  });

  test('stops after four cancelled attempts and reports the last failure', async () => {
    let reads = 0;
    let writes = 0;
    await expect(
      appendCatalogueParts(
        {
          actor,
          read: async () => {
            reads++;
            return Response.json({ structure, revision: 'current' });
          },
          send: async () => {
            writes++;
            return conflict();
          },
        },
        structure,
        parts,
      ),
    ).rejects.toThrow('read_basis_changed');
    expect(reads).toBe(4);
    expect(writes).toBe(4);
  });

  test('does not retry a different conflict or a denied read', async () => {
    let writes = 0;
    await expect(
      appendCatalogueParts(
        {
          actor,
          read: async () => Response.json({ structure, revision: 'current' }),
          send: async () => {
            writes++;
            return conflict('stale_head');
          },
        },
        structure,
        parts,
      ),
    ).rejects.toThrow('stale_head');
    expect(writes).toBe(1);
    await expect(
      appendCatalogueParts(
        {
          actor,
          read: async () => Response.json({ code: 'denied' }, { status: 403 }),
          send: async () => {
            writes++;
            return Response.json({});
          },
        },
        structure,
        parts,
      ),
    ).rejects.toThrow('denied');
    expect(writes).toBe(1);
  });
});

describe('catalogue public Work setup', () => {
  test('creates, publishes and selects text through public operations with returned heads', async () => {
    const requests: { path: string; body: unknown }[] = [];
    const created = {
      work: parts[0]!.work,
      mainVersion: 'main-version',
      mainRevision: 'main-revision',
    };
    const replies = [
      created,
      { contribution: 'contribution', draftRevision: 'draft-head' },
      { publicationDecision: 'decision' },
      { selection: 'selection' },
    ];
    const result = await createCatalogueWork(
      {
        actor,
        read: async () => {
          throw new Error('No setup read is needed');
        },
        send: async (method, path, body) => {
          expect(method).toBe('POST');
          requests.push({ path, body });
          return Response.json(replies[requests.length - 1], { status: 201 });
        },
      },
      'Catalogue title',
    );
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/works',
      '/v1/contributions',
      '/v1/contribution-publications',
      '/v1/publication-selections',
    ]);
    expect(requests[0]!.body).toMatchObject({
      authoring: 'own-work',
      actingSubject: actor,
      title: 'Catalogue title',
    });
    expect(requests[1]!.body).toMatchObject({
      work: created.work,
      language: 'ja',
      body: 'Catalogue title（本文）',
    });
    expect(requests[2]!.body).toMatchObject({
      contribution: 'contribution',
      expectedDraftHead: 'draft-head',
      expectedPublicationHead: null,
      disclosure: 'public',
    });
    expect(requests[3]!.body).toMatchObject({
      work: created.work,
      context: { kind: 'main-version-default', id: created.mainVersion },
      contribution: 'contribution',
      publicationDecision: 'decision',
      expectedSelectionHead: null,
    });
    expect(result).toEqual({ ...created, title: 'Catalogue title' });
  });

  test('does not publish or select a rejected draft', async () => {
    const paths: string[] = [];
    await expect(
      createCatalogueWork(
        {
          actor,
          read: async () => {
            throw new Error('No setup read is needed');
          },
          send: async (_method, path) => {
            paths.push(path);
            return path === '/v1/works'
              ? Response.json(
                  { work: parts[0]!.work, mainVersion: 'main-version' },
                  { status: 201 },
                )
              : Response.json({ code: 'denied' }, { status: 403 });
          },
        },
        'Catalogue title',
      ),
    ).rejects.toThrow('denied');
    expect(paths).toEqual(['/v1/works', '/v1/contributions']);
  });
});
