import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { acceptClassifiedStatement, discloseClassificationConcept, shareClassificationContext,
  type ClassificationPost, type ClassificationResolution } from '../../../scripts/dev/seed/classified-statement.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);
type Progress = { structure: string; occurrence: string; completed: boolean; position: string | null; version: number };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function settled(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 409 || attempt === 40
      || !(await response.clone().text()).includes('read_basis_changed')) return response;
    await new Promise(done => setTimeout(done, 500));
  }
}

test('identified anime watched progress resumes across devices and rejects stale updates through the API', async () => {
  const stack = await startMediaStack('typed-progress');
  try {
    const editor = await stack.member('anime-editor');
    const viewer = await stack.member('anime-viewer', { verified: true });
    const structureObjects = stack.objects('semantic/structure/');
    await structureObjects.initialize();
    Object.assign(stack.env, { structureObjects });

    // Separate sessions authenticate the same Account identity. Each Main app
    // owns its own progress store, so the second device must read persisted state.
    const secondToken = randomUUID();
    const device = (token: string) => createMainApp(stack.fuseki, {
      ...stack.composition.dependencies, environment: stack.env, structureObjects,
      progress: new StructureProgressStore(stack.contentPool),
      account: { verify: async request => {
        if (request.headers.get('authorization') !== `Bearer ${token}`) {
          throw new AccountAssertionDenied('Unknown anime viewer session');
        }
        const principal = { ...viewer.principal, emailVerified: true };
        return { ...principal, currentAssertion: async () => principal };
      } },
    });
    const first = device(viewer.token), second = device(secondToken);
    const call = (app: typeof first, token: string, method: string, path: string, body?: object) =>
      app.handle(new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    const person = (await json<{ agent: string }>(await call(first, viewer.token, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Returning anime viewer',
    }), 201)).agent;

    const title = 'Harbour Nights anime', semanticTypes = ['https://schema.org/TVSeries'];
    const show = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(editor.actor, 'work:create:root', 'work.create',
        metadataWorkRequestDigest(title, semanticTypes)) });
    const contribution = await stack.contribution(show.work, editor.actor, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: show.mainVersion }, work: show.work,
      contribution: contribution.contribution, publicationDecision: contribution.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    expect((await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${show.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection))
      .outcome).toBe('succeeded');

    for (const [scope, action] of [
      ['classification:define:global', 'classification.proposition.define'],
      ['context:create:root', 'context.create'],
      [`statement:speak:${editor.actor}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide'],
      [`work:read:${show.work}`, 'work.read'],
      [`work:edit:${show.work}`, 'work.edit'],
      ['semantic:create:root', 'semantic.change'],
    ] as const) await editor.grant(scope, action);
    const post: ClassificationPost = async <T>(path: string, body: unknown, _token: string, key: string) => {
      const response = await settled(() => editor.send('POST', path, body, key));
      expect([200, 201]).toContain(response.status);
      return json<T>(response, response.status);
    };
    const anime = await post<{ concept: string; sense: string; definitionRevision: string }>(
      '/v1/classification-vocabulary', { profile: 'classification-proposition-v2', scheme: null,
        labels: [{ language: 'en', value: 'Anime' }], alternativeLabels: [], broader: [], narrower: [],
        actingSubject: editor.actor }, editor.token, randomUUID());
    const interpretation = await shareClassificationContext(post, editor.token, editor.actor, [anime], randomUUID());
    await discloseClassificationConcept(post, editor.token, editor.actor, anime.concept, randomUUID());
    const resolve = () => post<ClassificationResolution>('/v1/classification-resolutions', {
      profile: 'classification-resolution-v1', context: { kind: 'global' }, work: show.work,
      mainVersion: show.mainVersion, sense: anime.sense,
    }, editor.token, randomUUID());
    await acceptClassifiedStatement(post, editor.token, editor.actor, show, anime.concept, interpretation,
      { kind: 'global' }, await resolve(), { statement: randomUUID(), decision: randomUUID() });
    const identified = await resolve();
    expect(identified).toMatchObject({ state: 'accepted', source: 'global' });
    expect(identified.decision).not.toBeNull();

    const targets: string[] = [];
    for (const number of [1, 2, 3]) {
      const episode = await json<{ component: string }>(await settled(() => editor.send('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
        state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
          { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Episode ${number}`, language: 'en' } },
          { predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: show.work } },
        ] },
      })), 201);
      targets.push(episode.component);
      await editor.grant(`semantic:read:${episode.component}`, 'semantic.read');
    }
    const composition = await json<{ structure: string; revision: string }>(await settled(() => editor.send('POST',
      '/v1/compositions', { profile: 'work-composition', work: show.work, mainVersion: show.mainVersion,
        actingSubject: editor.actor })), 201);
    const path = `/v1/compositions/${short(composition.structure)}`;
    const changed = await json<{ occurrences: string[] }>(await settled(() => editor.send('POST', `${path}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: editor.actor,
      operations: targets.map((target, index) => ({ op: 'insert', role: 'part', parent: composition.structure,
        position: 'last', target, displayLabel: `Episode ${index + 1}`, inclusion: 'required' })),
    })));
    expect(changed.occurrences).toHaveLength(3);
    const episode = changed.occurrences[0]!, nextEpisode = changed.occurrences[1]!;
    const progressPath = `${path}/occurrences/${short(episode)}/progress`;
    const actorQuery = `actingSubject=${encodeURIComponent(person)}`;
    const read = async (app: typeof first, token: string) =>
      json<Progress>(await call(app, token, 'GET', `${progressPath}?${actorQuery}`));
    const write = (app: typeof first, token: string, completed: boolean, expectedVersion: number) =>
      call(app, token, 'PUT', progressPath, { actingSubject: person, completed, expectedVersion, position: null });

    const initial = await read(first, viewer.token);
    expect(initial).toMatchObject({ completed: false, version: 0 });
    expect(await json<Progress>(await write(first, viewer.token, true, initial.version)))
      .toMatchObject({ completed: true, version: 1 });
    const resumed = await read(second, secondToken);
    expect(resumed).toMatchObject({ structure: composition.structure, occurrence: episode, completed: true, version: 1 });
    expect(await json(await call(second, secondToken, 'GET',
      `/v1/reading-positions/${short(show.work)}?${actorQuery}&position=mine&limit=1`)))
      .toMatchObject({ resolved: episode, scope: 'resume', items: [{ occurrence: episode, target: targets[0] }] });
    const positionsPath = `/v1/reading-positions/${short(show.work)}?${actorQuery}&position=start&limit=1`;
    const firstEpisode = await json<{ items: { occurrence: string }[]; nextCursor: string | null }>(
      await call(second, secondToken, 'GET', positionsPath));
    expect(firstEpisode.items).toMatchObject([{ occurrence: episode }]);
    expect(firstEpisode.nextCursor).not.toBeNull();
    expect(await json(await call(second, secondToken, 'GET',
      `${positionsPath}&cursor=${encodeURIComponent(firstEpisode.nextCursor!)}`)))
      .toMatchObject({ items: [{ occurrence: nextEpisode, target: targets[1], displayLabel: 'Episode 2' }] });

    expect(await json<Progress>(await write(second, secondToken, false, resumed.version)))
      .toMatchObject({ completed: false, version: 2 });
    expect(await read(first, viewer.token)).toMatchObject({ completed: false, version: 2 });
    const before = await Promise.all([read(first, viewer.token), read(second, secondToken)]);
    expect(before[0]).toEqual(before[1]);
    // Both devices submit from the same version. Only one compare-and-set may
    // commit; the refused request must leave the winner's state intact.
    const raced = await Promise.all([
      write(first, viewer.token, true, before[0]!.version),
      write(second, secondToken, false, before[1]!.version),
    ]);
    expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await json<Progress>(raced.find(response => response.status === 200)!);
    expect(winner.version).toBe(3);
    expect(await json(raced.find(response => response.status === 409)!, 409)).toMatchObject({ code: 'stale_progress' });
    for (const saved of await Promise.all([read(first, viewer.token), read(second, secondToken)])) {
      expect(saved).toMatchObject({ completed: winner.completed, position: winner.position, version: winner.version });
    }
  } finally { await stack.stop(); }
}, 300_000);
