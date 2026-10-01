// Seeds the Works the G-855 e2e imports against into the isolated QA stack the harness started, through
// the same route as `g-838-seed.ts`, and prints their titles as JSON. Two Works share one title, so a
// file row naming it is ambiguous; the others each match exactly one Work.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The G-855 seed writes only into an isolated QA run');
}
const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory || !path) throw new Error('MAIN_OBJECT_DIRECTORY and REZICS_WEB_AUTH_PRIVATE_PATH must name the running stack');
const reader = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };
const types = ['https://schema.org/Book'];

const stack = await startMediaStack('g855-e2e');
const workObjects = stack.objects('semantic/work/');
await workObjects.initialize();
Object.assign(stack.env, { objectDirectory, workObjects });
try {
  const editor = await stack.member('catalogue');
  const grantReader = async (scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, reader.actingSubject, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.actingSubject, scope, action]);
  };
  /** A public Work the signed-in member may read, as `g-838-catalogue.ts` writes one. */
  const work = async (title: string) => {
    const created = await activateMetadataWork(stack.env, { title, semanticTypes: types, admission: stack.admission(
      editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(created.work, editor.actor, 'ja', `${title}（本文）`);
    const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    const selected = await selectMainDefault(stack.env, stack.admission(editor.actor,
      `publication:select:${created.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection);
    if (selected.outcome !== 'succeeded') throw new Error(`Main selection failed for ${title}`);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    await editor.grant(`work:read:${created.work}`, 'work.read');
    await grantReader(`work:read:${created.work}`, 'work.read');
    return created.work;
  };
  const titles = ['Glass Harbor', 'Lantern Season', 'Moss and Salt', 'Twin Tides', 'Twin Tides'];
  // One at a time: each write moves the graph the next is checked against.
  for (const title of titles) await work(title);
  console.log(JSON.stringify({ matched: titles.slice(0, 3), ambiguous: 'Twin Tides' }));
} finally {
  await stack.stop();
}
