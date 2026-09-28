import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { feedWorkPresentations } from '../../../services/main/src/modules/feed/presentation.ts';
import { fenceAuthorNames } from '../../../services/main/src/modules/source/author-name-read.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { authorCreditFixture, author, shortId } from '../fixtures/author-credit.ts';

test('G-327 adopted source authors have named source-reported credits until individually confirmed', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = join(resolve('.temp'), `credit-reported-${randomUUID()}`);
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const proposal = await fixture.propose(`OL${Math.floor(Math.random() * 900000 + 100000)}W`,
      [author('/authors/OL1A'), author('/authors/OL2A')], 'Imported with source authors');
    const imported = await fixture.adoptWork(proposal);
    expect(await fixture.adoptions.boundWorks([imported.work])).toEqual(new Set([imported.work]));
    await fixture.grant(`work:read:${imported.work}`, 'work.read');
    const path = `/v1/works/${shortId(imported.work)}/credits?actingSubject=${encodeURIComponent(fixture.actor)}`;
    const before = await fixture.json<{ items: Array<{ key: string; confirmation?: string;
      displayName: string | null }> }>(await fixture.call('GET', path), 200);
    expect(before.items).toHaveLength(2);
    expect(before.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '/authors/OL1A', confirmation: 'source-reported', displayName: null }),
      expect.objectContaining({ key: '/authors/OL2A', confirmation: 'source-reported', displayName: null }),
    ]));
    fixture.setAuthorName('/authors/OL1A', 'Jane Austen');
    fixture.setAuthorName('/authors/OL2A', 'Another Author');
    await fixture.sourceAuthorNames.command(fixture.principalId, randomUUID(), '/authors/OL1A',
      { action: 'refresh', expectedRevision: null });
    await fixture.sourceAuthorNames.command(fixture.principalId, randomUUID(), '/authors/OL2A',
      { action: 'refresh', expectedRevision: null });
    const named = await fixture.json<{ items: Array<{ key: string; confirmation?: string;
      displayName: string | null; nameSource?: { basis: string; field: string } }> }>(
        await fixture.call('GET', path), 200);
    expect(named.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '/authors/OL1A', confirmation: 'source-reported', displayName: 'Jane Austen',
        nameSource: expect.objectContaining({ basis: 'facts', field: '/name' }) }),
      expect.objectContaining({ key: '/authors/OL2A', confirmation: 'source-reported', displayName: 'Another Author' }),
    ]));
    const presentationSession = new WorkReadSession({ environment: fixture.env,
      sourceAdoptions: fixture.adoptions, sourceAuthorNames: fixture.sourceAuthorNames } as MainWorkDependencies,
    new Request('http://main.local/v1/feed'), {}, { dataEpoch: fixture.env.lineage.dataEpoch, sequence: '0' });
    const presentation = await feedWorkPresentations(presentationSession, [imported.work]);
    expect(presentation.items.get(imported.work)?.authors).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '/authors/OL1A', displayName: 'Jane Austen', confirmation: 'source-reported' }),
      expect.objectContaining({ key: '/authors/OL2A', displayName: 'Another Author', confirmation: 'source-reported' }),
    ]));
    await presentation.fence();
    await fenceAuthorNames(presentationSession);
    await fixture.grant(`work:edit:${imported.work}`, 'work.edit');
    const confirmed = await fixture.json<{ support: { credit: { credit: string } } }>(await fixture.call('POST',
      `/v1/works/${shortId(imported.work)}/source-author-credits`,
      { ...fixture.input(proposal, imported, 0), nativeOrdinal: 7 }), 201);
    const after = await fixture.json<{ items: Array<{ id: string; key: string; confirmation?: string }> }>(
      await fixture.call('GET', path), 200);
    expect(after.items).toHaveLength(2);
    expect(after.items.find(item => item.key === '/authors/OL1A')?.id).toBe(confirmed.support.credit.credit);
    expect(after.items.find(item => item.key === '/authors/OL1A')).not.toHaveProperty('confirmation');
    expect(after.items.find(item => item.key === '/authors/OL2A'))
      .toMatchObject({ confirmation: 'source-reported' });
    const confirmedSession = new WorkReadSession({ environment: fixture.env,
      sourceAdoptions: fixture.adoptions, sourceAuthorNames: fixture.sourceAuthorNames } as MainWorkDependencies,
    new Request('http://main.local/v1/feed'), {}, { dataEpoch: fixture.env.lineage.dataEpoch, sequence: '0' });
    const confirmedPresentation = await feedWorkPresentations(confirmedSession, [imported.work]);
    expect(confirmedPresentation.items.get(imported.work)?.authors).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: '/authors/OL1A', displayName: 'Jane Austen', id: confirmed.support.credit.credit }),
      expect.objectContaining({ key: '/authors/OL2A', displayName: 'Another Author', confirmation: 'source-reported' }),
    ]));
    expect(confirmedPresentation.items.get(imported.work)?.authors.find(credit => credit.key === '/authors/OL1A'))
      .not.toHaveProperty('confirmation');
    await confirmedPresentation.fence();
    await fenceAuthorNames(confirmedSession);
  } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
