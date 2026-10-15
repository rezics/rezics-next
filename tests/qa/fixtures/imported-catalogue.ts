import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importDataset } from '../../../scripts/datasets/import.ts';
import { importedRightsAssessments, type ImportedSource } from '../../../services/main/src/modules/rights/import-policy.ts';
import type { DatasetSnapshot } from '../../../scripts/datasets/types.ts';

export interface ImportedCataloguePort {
  actor: string;
  root: string;
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key?: string): Promise<Response>;
}
export interface ImportedCatalogueFixture {
  works: Array<{ provider: ImportedSource['provider']; work: string; revision: string; title: string; url: string }>;
  summary: string;
}

/** Every catalogue record and rights assessment crosses Main's API. The Bangumi
 * record is from the same locked seed as the real importer, including its summary. */
export async function seedImportedCatalogue(port: ImportedCataloguePort): Promise<ImportedCatalogueFixture> {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir,
    '../../fixtures/seeds/bangumi/7102695a8c071619d0a9aa7254abac56d0fa394a2322d73b0ee6e463b1eb56d1.json'), 'utf8')) as {
      pins: { anime: { subject: { id: number; name: string; summary: string } } } };
  const subject = fixture.pins.anime.subject;
  const summary = subject.summary.replace(/[\u0000-\u001f\u007f]/g, ' ').normalize('NFC').trim();
  const source: DatasetSnapshot = { format: 'rezics-local-dataset-v1', id: 'imported-catalogue',
    digest: 'a'.repeat(64), createdAt: '2026-10-15T00:00:00Z', captures: [], images: [],
    sources: [{ provider: 'bangumi', roots: ['bangumi:subject:975'], edges: [], images: [], scope: {}, records: [{
      key: 'bangumi:subject:975', provider: 'bangumi', kind: 'subject', externalId: String(subject.id),
      title: subject.name, language: 'ja', sourceUrl: 'https://bgm.tv/subject/975',
      native: 'work', semanticTypes: ['https://schema.org/TVSeries'], data: { summary: subject.summary },
    }] }] };
  const imported = await importDataset(port.root, source, { actingSubject: port.actor,
    mainOrigin: 'http://main.local', webOrigin: 'http://web.local', relationships: false,
    api: { request: async (method, path, body, key) => {
      const response = await port.request(method, path, body, key);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    } } });
  const receipt = JSON.parse(readFileSync(imported.receiptFile, 'utf8')) as {
    native: Record<string, { id: string; receipt: { workRevision: string } }> };
  const bangumi = receipt.native['bangumi:subject:975']!;
  const works: ImportedCatalogueFixture['works'] = [{ provider: 'bangumi', work: bangumi.id,
    revision: bangumi.receipt.workRevision, title: subject.name, url: 'https://bgm.tv/subject/975' }];
  const sources: Array<ImportedSource & { title: string; type: string }> = [
    { provider: 'vndb', title: 'Fate/stay night', url: 'https://vndb.org/v11', type: 'VideoGame' },
    { provider: 'open-library', title: 'Pride and Prejudice', url: 'https://openlibrary.org/works/OL66554W', type: 'Book' },
    { provider: 'project-gutenberg', title: 'Baked Apples', url: 'https://www.gutenberg.org/ebooks/65061',
      credit: 'Fannie Merritt Farmer', type: 'Recipe' },
  ];
  for (const source of sources) {
    const key = `imported-catalogue:${source.provider}:${crypto.randomUUID()}`;
    const response = await port.request('POST', '/v1/work-imports/bulk', { actingSubject: port.actor,
      items: [{ key, input: { profile: 'work-catalogue-import-v1', expectedWorkHead: null,
        title: source.title, language: 'en', aliases: [], semanticTypes: [`https://schema.org/${source.type}`],
        evidence: source.url, credits: [], classifications: [] } }] }, key);
    const result = await response.json() as { items?: Array<{ status: string; receipt?: { work: string; workRevision: string } }> };
    const made = result.items?.[0];
    if (!response.ok || made?.status !== 'succeeded' || !made.receipt)
      throw new Error(`Catalogue import failed: ${response.status} ${JSON.stringify(result)}`);
    works.push({ provider: source.provider, work: made.receipt.work, revision: made.receipt.workRevision,
      title: source.title, url: source.url });
    for (const [index, assessment] of importedRightsAssessments(source, made.receipt.work).entries()) {
      const assessmentKey = `${key}:${index}`;
      const saved = await port.request('POST', '/v1/rights/use-assessments', {
        profile: 'rights-use-assessment-v1', actingSubject: port.actor, ...assessment,
        idempotencyKey: assessmentKey,
      }, assessmentKey);
      if (!saved.ok) throw new Error(`Source assessment failed (${source.provider}, ${assessment.useScope}): ${saved.status} ${await saved.text()}`);
      await saved.arrayBuffer();
    }
  }
  return { works, summary };
}
