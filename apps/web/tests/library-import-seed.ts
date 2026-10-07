import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { CATALOGUE_IMPORT_SCOPE } from '../../../services/main/src/modules/work/catalogue-import.ts';

// Seed only the title/author matches used by the browser journey. The reader never receives
// catalogue authority; the fixture editor provisions Authors and imports Works through Main's APIs.
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('Library import seed writes only into an isolated QA run');
}
const records = JSON.parse(process.argv[2] ?? 'null') as [string, string][];
if (!Array.isArray(records) || !records.length || records.some(record => !Array.isArray(record)
  || record.length !== 2 || record.some(value => typeof value !== 'string' || !value))) {
  throw new Error('Library import seed needs title and author pairs');
}
const stack = await startMediaStack('library-import-seed', { agents: true });
try {
  const workObjects = stack.objects('semantic/work/');
  await workObjects.initialize();
  stack.env.workObjects = workObjects;
  const editor = await stack.member('library-catalogue-editor', { stable: true });
  await editor.grant(CATALOGUE_IMPORT_SCOPE, 'work.create');
  await grantPlatformUse(await platformAdministratorSession(), editor.principalId, 'catalogue-import');
  const creators = new Map<string, string>();
  for (const [, name] of records) {
    if (creators.has(name)) continue;
    const response = await editor.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: name,
    }, `library-import-author:${creators.size}`);
    if (![200, 201].includes(response.status)) throw new Error(`Author seed failed: ${response.status} ${await response.text()}`);
    creators.set(name, (await response.json() as { agent: string }).agent);
  }
  const response = await editor.send('POST', '/v1/work-imports/bulk', {
    actingSubject: editor.actor,
    items: records.map(([title, name], index) => ({ key: `library-import-work:${index}`,
      input: { profile: 'work-catalogue-import-v1', expectedWorkHead: null, title, language: 'en',
        semanticTypes: ['https://schema.org/Book'], aliases: [],
        credits: [{ agent: creators.get(name)!, role: 'author' }], classifications: [],
        evidence: 'Library import browser fixture' } })),
  });
  if (response.status !== 200) throw new Error(`Catalogue seed failed: ${response.status} ${await response.text()}`);
  const result = await response.json() as { complete: boolean; partial: boolean; items: { status: string }[] };
  if (!result.complete || result.partial || result.items.length !== records.length
    || result.items.some(item => item.status !== 'succeeded')) {
    throw new Error(`Catalogue seed incomplete: ${JSON.stringify(result)}`);
  }
} finally {
  await stack.stop();
}
