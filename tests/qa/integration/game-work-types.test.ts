import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, hash, iri } from '../../../services/main/src/modules/work/activate.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { startMediaStack } from './media-support.ts';

const game = 'https://schema.org/VideoGame';
const short = (id: string) => id.slice(-36);

test('VideoGame creation and v2 type edits validate without changing persisted v1 admission', async () => {
  const stack = await startMediaStack('game-type-v2');
  try {
    const editor = await stack.member('game-editor');
    await editor.grant('work:create:root', 'work.create');
    await createAgentGraph(stack.env, { id: randomUUID(), agent: editor.actor, kind: 'person',
      displayName: 'Game author', digest: hash(editor.actor) });
    const created = await editor.send('POST', '/v1/works', { profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: `Game ${randomUUID()}`, language: 'en', semanticTypes: [game], actingSubject: editor.actor });
    expect(created.status).toBe(201);
    const gameWork = await created.json() as { work: string };
    expect((await stack.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(gameWork.work)} a <${game}> . } }`)).boolean).toBe(true);

    const generic = await editor.send('POST', '/v1/works', { profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: `Untyped ${randomUUID()}`, language: 'en', actingSubject: editor.actor });
    expect(generic.status).toBe(201);
    const target = await generic.json() as { work: string; workRevision: string };
    await editor.grant(`work:edit:${target.work}`, 'work.edit');
    const path = `/v1/works/${short(target.work)}/type`;
    const input = { expectedHead: target.workRevision, types: [game], actingSubject: editor.actor };
    expect((await editor.send('PUT', path, { profile: 'work-type-v1', ...input })).status).toBe(400);
    const updated = await editor.send('PUT', path, { profile: 'work-type-v2', ...input });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ profile: 'work-type-v2', types: [game] });
  } finally { await stack.stop(); }
}, 120_000);
