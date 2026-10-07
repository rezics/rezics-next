import { describe, expect, test } from 'bun:test';
import { appendCatalogueParts } from './g-838-catalogue.ts';

const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-7000-8000-000000000002';
const parts = [{ work: 'https://rezics.com/id/00000000-0000-7000-8000-000000000003', label: '1' }];
const conflict = (code = 'read_basis_changed') => Response.json({ code }, { status: 409 });

describe('catalogue seed composition recovery', () => {
  test('rereads the head and reapplies the ordered part intent with a fresh key', async () => {
    const events: string[] = [];
    const writes: { body: unknown; key: string | undefined }[] = [];
    await appendCatalogueParts({
      actor,
      read: async path => {
        events.push(`GET ${path}`);
        return Response.json({ structure, revision: `head-${writes.length}` });
      },
      send: async (method, path, body, key) => {
        events.push(`${method} ${path}`);
        writes.push({ body, key });
        return writes.length === 1 ? conflict() : Response.json({ revision: 'saved' });
      },
    }, structure, parts);
    expect(events.map(event => event.split(' ')[0])).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(events[0]).toBe(`GET /v1/compositions/${structure.slice(-36)}`);
    expect(writes.map(write => (write.body as { expectedHead: string }).expectedHead)).toEqual(['head-0', 'head-1']);
    expect(writes[0]!.key).toBeString();
    expect(writes[1]!.key).toBeString();
    expect(writes[0]!.key).not.toBe(writes[1]!.key);
    for (const write of writes) expect(write.body).toMatchObject({
      profile: 'work-composition', actingSubject: actor,
      operations: [{ op: 'insert', parent: structure, position: 'last', role: 'part',
        target: parts[0]!.work, displayLabel: '1', inclusion: 'required' }],
    });
  });

  test('restarts a stale read before sending any edit', async () => {
    let reads = 0;
    let writes = 0;
    await appendCatalogueParts({
      actor,
      read: async () => ++reads === 1 ? conflict() : Response.json({ structure, revision: 'current' }),
      send: async () => { writes++; return Response.json({ revision: 'saved' }); },
    }, structure, parts);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  test('stops after four cancelled attempts and reports the last failure', async () => {
    let reads = 0;
    let writes = 0;
    await expect(appendCatalogueParts({
      actor,
      read: async () => { reads++; return Response.json({ structure, revision: 'current' }); },
      send: async () => { writes++; return conflict(); },
    }, structure, parts)).rejects.toThrow('read_basis_changed');
    expect(reads).toBe(4);
    expect(writes).toBe(4);
  });

  test('does not retry a different conflict or a denied read', async () => {
    let writes = 0;
    await expect(appendCatalogueParts({
      actor,
      read: async () => Response.json({ structure, revision: 'current' }),
      send: async () => { writes++; return conflict('stale_head'); },
    }, structure, parts)).rejects.toThrow('stale_head');
    expect(writes).toBe(1);
    await expect(appendCatalogueParts({
      actor,
      read: async () => Response.json({ code: 'denied' }, { status: 403 }),
      send: async () => { writes++; return Response.json({}); },
    }, structure, parts)).rejects.toThrow('denied');
    expect(writes).toBe(1);
  });
});
