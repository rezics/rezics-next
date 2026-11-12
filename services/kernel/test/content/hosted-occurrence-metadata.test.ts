import { expect, setDefaultTimeout, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import { createHash } from 'node:crypto';
import readChain from '../../src/content/read-chain.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

test('mounted occurrence metadata preserves selection and disclosure without body reads; exact opening keeps bytes', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    const target = f.target(await f.native.thread());
    const protectedTarget = await f.protectedChapter();
    const ids = Array.from({ length: 3 }, () => f.newOccurrenceId());
    const path = `/v1/hostedCatalogues/${f.catalogueId}`;
    const created = await f.native.command('/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements: ids.map((occurrenceId, position) => ({
        occurrenceId,
        parentId: null,
        position,
        title: `Slot ${position}`,
        ...(position === 2 ? { kind: 'part' } : { kind: 'chapter', target: position ? protectedTarget : target }),
      })),
    });
    const published = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: created.revisionId,
        expectedPublicationId: null,
        occurrenceIds: ids,
      },
      200,
    );
    const get = (id: string, query = '', anonymous = true) =>
      f.native.call('GET', `${path}/occurrences/${id}/metadata${query}`, undefined, { anonymous });
    const start = observer.records.length;
    for (const [query, revisionId, kind, sourceRevisionId, anonymous] of [
      ['', published.revisionId, 'publication', created.revisionId, true],
      [
        `?revisionId=${published.revisionId}&kind=publication`,
        published.revisionId,
        'publication',
        created.revisionId,
        true,
      ],
      ['?kind=structure', created.revisionId, 'structure', null, false],
    ] as const) {
      const result = await get(ids[0]!, query, anonymous);
      expect(result.status).toBe(200);
      expect(result.value).toEqual({
        catalogueId: f.catalogueId,
        revisionId,
        kind,
        sourceRevisionId,
        occurrence: {
          occurrenceId: ids[0],
          parentId: null,
          position: 0,
          kind: 'chapter',
          availability: 'available',
          title: 'Slot 0',
          target,
        },
      });
    }
    expect((await get(ids[1]!)).value.occurrence).toEqual({
      occurrenceId: ids[1],
      parentId: null,
      position: 1,
      kind: 'chapter',
      availability: 'unavailable',
    });
    expect((await get(ids[2]!)).value.occurrence).toEqual({
      occurrenceId: ids[2],
      parentId: null,
      position: 2,
      kind: 'part',
      availability: 'available',
      title: 'Slot 2',
      target: null,
    });
    for (const [id, query, status] of [
      [ids[0]!, '?kind=structure', 404],
      [ids[0]!, `?revisionId=${published.revisionId}&kind=structure`, 404],
      [f.newOccurrenceId(), '', 404],
      [ids[0]!, '?kind=invalid', 400],
      [ids[0]!, '?revisionId=invalid', 400],
      [ids[0]!, '?document=true', 400],
    ] as const)
      expect((await get(id, query)).status).toBe(status);
    const response = await f.native.system.kernel.handle(
      new Request(`https://content.test${path}/occurrences/${ids[0]}/metadata`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
    await response.json();
    await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: created.revisionId,
        expectedPublicationId: published.revisionId,
        occurrenceIds: [],
      },
      200,
    );
    expect((await get(ids[0]!)).status).toBe(404);
    const historical = await get(ids[0]!, `?revisionId=${published.revisionId}`);
    expect(historical.status).toBe(200);
    expect(historical.value.occurrence.target).toEqual(target);
    const bodyProbes = (from: number) =>
      observer.records
        .slice(from)
        .filter(
          (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
        );
    expect(bodyProbes(start)).toHaveLength(0);
    const beforeOpen = observer.records.length;
    const opened = await f.native.call(
      'GET',
      `${path}/occurrences/${ids[0]}?revisionId=${published.revisionId}`,
      undefined,
      { anonymous: true },
    );
    expect(opened.status).toBe(200);
    expect(opened.value.occurrence).toEqual(historical.value.occurrence);
    expect(createHash('sha256').update(Buffer.from(opened.value.document.canonicalBytes, 'base64')).digest('hex')).toBe(
      target.sha256,
    );
    expect(bodyProbes(beforeOpen)).toHaveLength(1);
  } finally {
    await observer.close();
    await f.close();
  }
});
