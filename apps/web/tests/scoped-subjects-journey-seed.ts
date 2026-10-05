// The scoped-subjects demo (the dev seed's own loader) written through Main's public commands into the browser QA stack, then
// opened to the signed-in web member: Access grants are the only fixture authority. A second episode of one Work is added,
// so that a character's episodes have a combined view.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SeedApiError } from '../../../scripts/dev/seed/api.ts';
import { loadScopedSubjects } from '../../../scripts/dev/seed/scoped-subjects.ts';
import type { ScopedSubjectApi } from '../../../scripts/dev/seed/scoped-subjects-questions.ts';
import { scopedSubjectsFixture } from '../../../tests/qa/integration/scoped-subjects-support.ts';

if (!process.env.REZICS_QA_RUN_ID || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH)
  throw new Error('Use the browser QA stack');
const web = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH, 'utf8')) as {
  principalId: string;
  actingSubject: string;
};
const short = (ref: string) => ref.slice(-36);
const h = await scopedSubjectsFixture();

/** A command Access has admitted but whose owner has not applied answers 202; the same request under the same key settles it. */
async function settled<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const pending = error instanceof SeedApiError && [202, 503].includes(error.status);
      if (!pending || attempt >= 120) throw error;
      await Bun.sleep(1000);
    }
  }
}
const patient = (person: Parameters<typeof h.api>[0]): ScopedSubjectApi => {
  const api = h.api(person);
  return {
    get: (path) => settled(() => api.get(path)),
    post: (path, body, key) => settled(() => api.post(path, body, key)),
    put: (path, body, key) => settled(() => api.put(path, body, key)),
  };
};
try {
  const raters = [h.owner];
  for (let index = 1; index < 50; index++) raters.push(await h.person(`Map reader ${index + 1}`));
  const manifest = await loadScopedSubjects({
    api: patient(h.owner),
    actor: h.owner.actor,
    namespace: `journey-${process.env.REZICS_QA_RUN_ID}`,
    authorize: (scope, action, actor) => h.authorize(scope, action, actor),
    raters: raters.map((person) => ({ actor: person.actor, api: patient(person) })),
  });

  // The web member reads everything the demo made and may rate in each of its questions.
  const grant = async (scope: string, action: string) => {
    await h.stack.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await h.stack.accessPool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), web.principalId, web.actingSubject, action],
    );
    await h.stack.accessPool.query(
      `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), web.actingSubject, scope, action],
    );
  };
  for (const ref of [
    ...Object.values(manifest.subjects),
    ...Object.values(manifest.relations).map((relation) => relation.occurrence),
    ...Object.values(manifest.definitions),
    manifest.variantKind,
  ])
    await grant(`semantic:read:${ref}`, 'semantic.read');
  for (const work of Object.values(manifest.works)) {
    await grant(`work:read:${work.work}`, 'work.read');
  }
  for (const context of [
    manifest.questions.character.context,
    manifest.questions.performance.context,
    manifest.questions.unit.context,
    manifest.itemQuestion,
  ])
    await grant(`rating:observe:${context}`, 'rating.observation.set');

  // A second episode placement in the same reading order gives Misaka's episodes a combined view.
  const railgun = manifest.positions['railgun-episode']!;
  const composition = await patient(h.owner).get<{ revision: string }>(
    `/v1/compositions/${short(railgun.structure)}?actingSubject=${encodeURIComponent(h.owner.actor)}`,
  );
  const added = await patient(h.owner).post<{ occurrences: string[] }>(
    `/v1/compositions/${short(railgun.structure)}/changes`,
    {
      profile: 'work-composition',
      expectedHead: composition.revision,
      actingSubject: h.owner.actor,
      operations: [
        {
          op: 'insert',
          parent: railgun.structure,
          position: 'last',
          role: 'part',
          target: manifest.works['railgun-episode-4']!.work,
          displayLabel: 'Season 1, episode 4',
          inclusion: 'required',
          label: { value: 'Season 1, episode 4', language: 'en' },
        },
      ],
    },
    randomUUID(),
  );
  await grant(`semantic:read:${added.occurrences[0]!}`, 'semantic.read');
  const second = await patient(h.owner).post<{ projection: { id: string } }>(
    '/v1/projections',
    {
      subject: manifest.subjects.misaka!,
      frames: [added.occurrences[0]!],
      actingSubject: h.owner.actor,
    },
    randomUUID(),
  );

  const seeded = { ...manifest, secondEpisode: second.projection.id };
  const directory = resolve('.temp/scoped-subjects-journey', process.env.REZICS_QA_RUN_ID);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify(seeded));
  console.log(JSON.stringify(seeded));
} finally {
  await h.stop();
}
