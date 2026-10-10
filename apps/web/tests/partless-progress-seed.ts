// Seeds one visual novel with no parts into the isolated QA stack and writes its id for the journey.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';

const types = ['https://schema.org/VideoGame'];
export const novel = { title: 'Paper Cranes' } as const;
export interface PartlessWork { work: string; title: string }

export async function seedPartlessWork(stack: MediaStack, reader: { principalId: string; actor: string }): Promise<PartlessWork> {
  const editor = await stack.member('partless');
  const grant = async (who: { principalId: string; actor: string }, action: string, scopes: string[]) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [scopes]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), who.principalId, who.actor, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      SELECT gen_random_uuid(), $1, $1, scope, $2, now() + interval '8 hours' FROM unnest($3::text[]) AS scope`, [who.actor, action, scopes]);
  };
  const created = await activateMetadataWork(stack.env, { title: novel.title, semanticTypes: types, admission: stack.admission(
    editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(novel.title, types)) });
  const text = await stack.contribution(created.work, editor.actor, 'en', `${novel.title} is a visual novel with nowhere to put a chapter.`);
  const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
  const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
    `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
  if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${novel.title}`);
  await grant(editor, 'work.read', [`work:read:${created.work}`]);
  await grant(reader, 'work.read', [`work:read:${created.work}`]);
  return { work: created.work, title: novel.title };
}

if (import.meta.main) {
  const run = process.env.REZICS_QA_RUN_ID ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('The partless seed writes only into an isolated QA run');
  const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
  const { principalId, actingSubject } = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };
  const stack = await startMediaStack('partless-e2e');
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  Object.assign(stack.env, { objectDirectory, workObjects });
  try {
    const seeded = await seedPartlessWork(stack, { principalId, actor: actingSubject });
    const directory = resolve('.temp/partless-progress', run);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'seed.json'), JSON.stringify(seeded));
    console.log(JSON.stringify(seeded));
  } finally {
    await stack.stop();
  }
}
