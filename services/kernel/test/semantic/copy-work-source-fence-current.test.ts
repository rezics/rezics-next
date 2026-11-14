import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Source } from '@rezics/definitions/bulk';
import { COPY_WORK_PROPERTY, readCopyWorkDisclosure } from '../../src/semantic/copy-work-disclosure.ts';
import { sourceTuple } from '../../src/semantic/fences.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { citedValue, createListPresentationFixture, listRouteKey } from './support/list-presentation-fixture.ts';

function sourceOnOtherHomes(edition: string, work: string): Source {
  const excludedHomes = new Set([partitionOf(routeOf(edition)!), partitionOf(routeOf(work)!)]);
  for (let attempt = 0; attempt < 128; attempt++) {
    const source: Source = {
      source: 'native_list_fixture',
      external_id: randomUUID(),
      record_revision: '1',
      digest: 'a'.repeat(64),
      converter_revision: '1',
      field_group: 'facts',
    };
    if (!excludedHomes.has(partitionOf(sourceTuple(listRouteKey, source).route))) return source;
  }
  throw new Error('Could not select a Source-fence home outside the edition and work homes');
}

test('native cross-home copy-work witness expires on takedown and replacement membership reads current', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const work = await f.create('schema:Book', {}, { en: 'Harbour' });
    const edition = await f.create('bf:Instance', {}, { en: 'Harbour paperback' });
    const source = sourceOnOtherHomes(edition, work);
    const fenceHome = partitionOf(sourceTuple(listRouteKey, source).route);
    expect(fenceHome).not.toBe(partitionOf(routeOf(edition)!));
    expect(fenceHome).not.toBe(partitionOf(routeOf(work)!));
    const proposal = await f.batch({
      op: 'propose',
      key: randomUUID(),
      source,
      subject: edition,
      statement: citedValue(COPY_WORK_PROPERTY, work),
    });
    await f.adopt(edition, COPY_WORK_PROPERTY, [proposal.candidate as string]);

    const deps = { ...(await f.deps('anonymous')), deadline: Date.now() + 180_000 };
    const observed = await readCopyWorkDisclosure(deps, { identities: [edition], languages: ['en'] });
    expect(observed.results.get(edition)).toEqual({
      state: 'available',
      works: [{ id: work, labels: { en: 'Harbour' } }],
    });
    expect(await observed.current()).toBe(true);

    await f.checked('POST', '/v1/sourceFences:takedown', {
      source: source.source,
      externalId: source.external_id,
      fieldGroup: source.field_group,
      reason: 'Provider revoked the imported work relation',
    });
    expect(await observed.current()).toBe(false);
    const withheld = await readCopyWorkDisclosure(deps, { identities: [edition], languages: ['en'] });
    expect(withheld.results.get(edition)).toEqual({ state: 'withheld' });
    expect(JSON.stringify(withheld.results.get(edition))).not.toContain(work);

    // Content fences are permanent; replacement membership uses a new imported source identity.
    const replacement = { ...source, external_id: randomUUID() };
    const replacementProposal = await f.batch({
      op: 'propose',
      key: randomUUID(),
      source: replacement,
      subject: edition,
      statement: citedValue(COPY_WORK_PROPERTY, work),
    });
    const expectedHead = (
      await f.pool.query<{ revision: number }>(
        'SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1',
        [routeOf(edition)!, edition],
      )
    ).rows[0]!.revision;
    await f.adopt(edition, COPY_WORK_PROPERTY, [replacementProposal.candidate as string], expectedHead);
    const replacementRead = await readCopyWorkDisclosure(deps, { identities: [edition], languages: ['en'] });
    expect(replacementRead.results.get(edition)).toEqual({
      state: 'available',
      works: [{ id: work, labels: { en: 'Harbour' } }],
    });
    expect(await replacementRead.current()).toBe(true);
  } finally {
    await f.close();
  }
}, 180_000);
