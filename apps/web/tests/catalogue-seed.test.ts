import { describe, expect, spyOn, test } from 'bun:test';
import { appendCatalogueParts, createCatalogueWork } from './g-838-catalogue.ts';
import {
  catalogueCommandResult,
  readCatalogueCommandBasis,
  reviewedCatalogueLexicon,
  settledCatalogueSend,
} from './g-837-catalogue.ts';
import { seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { presentationAction } from '../../../services/main/src/modules/lexicon/schema.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-7000-8000-000000000002';
const parts = [{ work: 'https://rezics.com/id/00000000-0000-7000-8000-000000000003', label: '1' }];
const conflict = (code = 'read_basis_changed') => Response.json({ code }, { status: 409 });

describe('catalogue labels follow Main presentation review', () => {
  const definition = relationLexiconSeed.find((item) => item.key === 'sequel')!;
  const receipt = { component: actor, revision: structure };

  test('seeds reviewed labels in every language and direction after obtaining exact definition review authority', async () => {
    const directory = mkdtempSync(resolve('.temp/catalogue-review-'));
    const events: string[] = [];
    const presentations: {
      state: {
        reviewStatus: 'draft' | 'reviewed';
        definition: string;
        language: string;
        fromRole: string;
        toRole: string;
        noun: string;
        heading: string;
        licence: string;
      };
    }[] = [];
    const client = reviewedCatalogueLexicon(
      {
        post: async <T>(path: string, body: object) => {
          events.push(path);
          if (path === '/v1/lexicon/presentations')
            presentations.push(body as (typeof presentations)[number]);
          return receipt as T;
        },
        authorizeDefinition: async (current) => {
          events.push(`read:${current.component}`);
        },
      },
      async (reference) => {
        events.push(`review:${reference}`);
      },
    );
    try {
      await seedRelationLexicon(
        client,
        actor,
        'catalogue-review',
        [definition],
        join(directory, 'map.json'),
      );
      expect(events.indexOf(`read:${actor}`)).toBeLessThan(events.indexOf(`review:${actor}`));
      expect(events.indexOf(`review:${actor}`)).toBeLessThan(
        events.indexOf('/v1/lexicon/presentations'),
      );
      expect(presentations).toHaveLength(definition.labels.length * 2);
      for (const [
        index,
        [language, noun, heading, inverseNoun, inverseHeading],
      ] of definition.labels.entries()) {
        expect(presentations[index * 2]!.state).toMatchObject({
          definition: actor,
          language,
          noun,
          heading,
          fromRole: definition.roles[0],
          toRole: definition.roles[1],
          reviewStatus: 'reviewed',
        });
        expect(presentations[index * 2 + 1]!.state).toMatchObject({
          definition: actor,
          language,
          noun: inverseNoun,
          heading: inverseHeading,
          fromRole: definition.roles[1],
          toRole: definition.roles[0],
          reviewStatus: 'reviewed',
        });
      }
      expect(
        presentations.every(
          (item) => presentationAction(item.state) === 'lexicon.presentation.review',
        ),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a refused review grant prevents every presentation write', async () => {
    const directory = mkdtempSync(resolve('.temp/catalogue-review-denied-'));
    const paths: string[] = [];
    const client = reviewedCatalogueLexicon(
      {
        post: async <T>(path: string) => {
          paths.push(path);
          return receipt as T;
        },
        authorizeDefinition: async () => {},
      },
      async () => {
        throw new Error('fixture scope is closed');
      },
    );
    try {
      await expect(
        seedRelationLexicon(
          client,
          actor,
          'catalogue-review-denied',
          [definition],
          join(directory, 'map.json'),
        ),
      ).rejects.toThrow('fixture scope is closed');
      expect(paths).toEqual(['/v1/semantic/changes']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('catalogue seed pending commands', () => {
  test('refreshes each affected catalogue owner through its current public read', async () => {
    const workPath = `/v1/works/${actor.slice(-36)}`;
    const structurePath = `/v1/compositions/${structure.slice(-36)}`;
    for (const [path, body, expected] of [
      [
        '/v1/lexicon/presentations',
        { state: { definition: actor } },
        [`/v1/semantic/resources/${actor.slice(-36)}`],
      ],
      ['/v1/compositions', { work: actor, mainVersion: structure }, [workPath]],
      [`${structurePath}/changes`, { expectedHead: 'pinned-head' }, [structurePath]],
      [
        `/v1/resources/${actor.slice(-36)}/derivations`,
        { sourceWork: parts[0]!.work },
        [workPath, `/v1/works/${parts[0]!.work.slice(-36)}`],
      ],
      [
        '/v1/relations/changes',
        {
          participations: [
            { participant: { kind: 'resource', ref: actor } },
            { participant: { kind: 'resource', ref: actor } },
          ],
        },
        [workPath],
      ],
      [
        `/v1/collections/${structure.slice(-36)}/changes`,
        {},
        [`/v1/collections/${structure.slice(-36)}`],
      ],
      [`${workPath}/realizations/${structure.slice(-36)}`, {}, [workPath]],
      [`${workPath}/releases/${structure.slice(-36)}`, {}, [workPath]],
    ] as const) {
      const reads: string[] = [];
      await readCatalogueCommandBasis(
        async (current) => {
          reads.push(current);
          return Response.json({ revision: 'current-basis' });
        },
        'POST',
        path,
        body,
      );
      expect(reads).toEqual([...expected]);
    }
  });

  test('a moving basis read must settle before resubmission, and a denied read stops it', async () => {
    let reads = 0;
    await readCatalogueCommandBasis(
      async () => (++reads < 3 ? conflict() : Response.json({ revision: 'current' })),
      'POST',
      '/v1/lexicon/presentations',
      { state: { definition: actor } },
    );
    expect(reads).toBe(3);
    for (const status of [403, 409]) {
      reads = 0;
      await expect(
        readCatalogueCommandBasis(
          async () => {
            reads += 1;
            return Response.json(
              { code: status === 409 ? 'read_basis_changed' : 'denied' },
              { status },
            );
          },
          'POST',
          '/v1/lexicon/presentations',
          { state: { definition: actor } },
        ),
      ).rejects.toThrow(`Expected 200, got ${status}`);
      expect(reads).toBe(status === 409 ? 4 : 1);
    }
  });

  for (const suppliedKey of [undefined, 'original-command']) {
    test(`refreshes a moved read basis and preserves the ${suppliedKey ? 'supplied' : 'generated'} command key through pending replay`, async () => {
      const events: string[] = [];
      const writes: { body: unknown; key: string | undefined }[] = [];
      const body = { work: actor, mainVersion: structure, actingSubject: actor };
      const send = settledCatalogueSend(
        async (_method, _path, value, key) => {
          events.push('write');
          writes.push({ body: value, key });
          if (writes.length === 1) return conflict();
          if (writes.length === 2)
            return Response.json({ operationId: key, retry: { afterMs: 0 } }, { status: 202 });
          return Response.json({ structure, revision: 'saved', replayed: true });
        },
        async (method, path, value) => {
          expect(method).toBe('POST');
          expect(path).toBe('/v1/compositions');
          expect(value).toBe(body);
          events.push('read-current-basis');
        },
      );
      expect(
          await catalogueCommandResult<{ structure: string; revision: string; replayed: boolean }>(
          await send('POST', '/v1/compositions', body, suppliedKey),
          201,
        ),
      ).toEqual({ structure, revision: 'saved', replayed: true });
      expect(events).toEqual(['write', 'read-current-basis', 'write', 'write']);
      expect(writes[0]!.key).toBeString();
      if (suppliedKey) expect(writes[0]!.key).toBe(suppliedKey);
      expect(writes.every((write) => write.key === writes[0]!.key && write.body === body)).toBe(
        true,
      );
    });
  }

  test('bounds repeated read-basis movement without replacing the command key', async () => {
    const keys: (string | undefined)[] = [];
    let reads = 0;
    const send = settledCatalogueSend(
      async (_method, _path, _body, key) => {
        keys.push(key);
        return conflict();
      },
      async () => {
        reads += 1;
      },
    );
    const response = await send('POST', '/v1/compositions', {}, 'original-command');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'read_basis_changed' });
    expect(keys).toEqual(Array(4).fill('original-command'));
    expect(reads).toBe(3);
  });

  test('does not retry when refreshing the current basis is denied', async () => {
    let writes = 0;
    const send = settledCatalogueSend(
      async () => {
        writes += 1;
        return conflict();
      },
      async () => {
        throw new Error('basis read denied');
      },
    );
    await expect(send('POST', '/v1/compositions', {}, 'original-command')).rejects.toThrow(
      'basis read denied',
    );
    expect(writes).toBe(1);
  });

  test('only read_basis_changed authorizes a basis refresh', async () => {
    for (const response of [
      conflict('stale_composition_head'),
      conflict('idempotency_conflict'),
      Response.json({ code: 'read_basis_changed' }, { status: 403 }),
      new Response('invalid JSON', { status: 409 }),
    ]) {
      let writes = 0;
      let reads = 0;
      const send = settledCatalogueSend(
        async () => {
          writes += 1;
          return response;
        },
        async () => {
          reads += 1;
        },
      );
      expect(await send('POST', '/v1/compositions', {}, 'original-command')).toBe(response);
      expect(writes).toBe(1);
      expect(reads).toBe(0);
    }
  });

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
        : Response.json({ code: 'stale_composition_head' }, { status: 409 });
    });
    const response = await send('POST', '/v1/compositions/structure/changes', {}, 'original-key');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'stale_composition_head' });
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
