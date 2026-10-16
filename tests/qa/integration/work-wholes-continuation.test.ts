import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string };
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('Work wholes continuation survives a private draft and restarts for a new visible use', async () => {
  const stack = await startMediaStack('work-wholes-continuation');
  try {
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const editor = await stack.member('composition-editor');
    const part = await stack.publicWork(editor.actor, ['en'], 'A shared volume');
    let first: Composition | undefined;
    const insert = (composition: Composition) => editor.send('POST',
      `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
        profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
        operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'part', target: part.work,
          displayLabel: 'Shared volume', inclusion: 'required' }],
      });
    for (const title of ['First series', 'Second series']) {
      const whole = await stack.publicWork(editor.actor, ['en'], title);
      await editor.grant(`work:edit:${whole.work}`, 'work.edit');
      const created = await json<Composition>(await editor.send('POST', '/v1/compositions', {
        profile: 'work-composition', work: whole.work, mainVersion: whole.mainVersion, actingSubject: editor.actor,
      }), 201);
      const changed = await json<Composition>(await insert(created));
      first ??= changed;
    }
    const path = `/v1/resources/${part.work.slice(-36)}/wholes?limit=1`;
    const page = await json<{ next: string }>(await stack.call('GET', path));
    expect(page.next).toBeString();
    await stack.privateWork(editor.actor, 'An invisible private draft');
    expect((await stack.call('GET', `${path}&after=${encodeURIComponent(page.next)}`)).status).toBe(200);
    await json(await insert(first!));
    expect((await stack.call('GET', `${path}&after=${encodeURIComponent(page.next)}`)).status).toBe(409);
  } finally { await stack.stop(); }
}, 60_000);
