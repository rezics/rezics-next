import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { resolvedTarget } from '../src/modules/target/contract.ts';
import { resolveCommandTarget, TargetUnavailable, type TargetReadSession } from '../src/modules/target/resolve.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { zoneHomeTargetFixture, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

test('home command identity uses the native published P/H grain without Content hydration', async () => {
  const h = zoneHomeTargetFixture();
  const position = { dataEpoch: 'epoch', sequence: '9' };
  const session = { checkDeadline() {}, position, query: async (query: string, limit: number) => {
    expect(limit).toBe(64);
    expect(query).toContain('rv:homeDocumentHead ?revision');
    expect(query).toContain('a rv:ZoneHomeRevision, rv:RevisionAnchor');
    expect(query).toContain('rv:homeRevision ?revision');
    expect(query).toContain('rv:outcome rv:Succeeded');
    expect(query).toContain('rv:ErasedRevision');
    expect(query).not.toContain('rv:contentRevision');
    expect(query).not.toContain('rdfs:label');
    return [{ epoch: cell(position.dataEpoch), sequence: cell(position.sequence),
      r: cell(h.resource), base: cell('resource'), revision: cell(h.revision),
      type: cell('https://rezics.com/vocab/ZoneHomeDocument') }];
  } } as unknown as TargetReadSession;
  expect(await resolveCommandTarget(session, h.resource)).toEqual({ resource: h.resource,
    revision: h.revision, base: 'resource', work: null, disclosure: 'restricted',
    types: ['https://rezics.com/vocab/ZoneHomeDocument'] });
});

test('home command identity refuses absent, competing and moving native cuts', async () => {
  const h = zoneHomeTargetFixture(), position = { dataEpoch: 'epoch', sequence: '9' };
  const row = { epoch: cell(position.dataEpoch), sequence: cell(position.sequence),
    r: cell(h.resource), base: cell('resource'), revision: cell(h.revision),
    type: cell('https://rezics.com/vocab/ZoneHomeDocument') };
  const session = (rows: object[]) => ({ checkDeadline() {}, position,
    query: async () => rows }) as unknown as TargetReadSession;
  await expect(resolveCommandTarget(session([{ epoch: row.epoch, sequence: row.sequence }]), h.resource))
    .rejects.toBeInstanceOf(TargetUnavailable);
  await expect(resolveCommandTarget(session([row, { ...row, revision: cell(h.siteRevision) }]), h.resource))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(resolveCommandTarget(session([{ ...row, sequence: cell('10') }]), h.resource))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('resolved home contract carries bounded exact variant, Content revision and digest selections', () => {
  const h = zoneHomeTargetFixture();
  const target = { resource: h.resource, revision: h.revision, base: 'resource', work: null,
    disclosure: 'public', types: ['https://rezics.com/vocab/ZoneHomeDocument'], contentSelections: h.selections };
  expect(Value.Check(resolvedTarget, target)).toBe(true);
  for (const contentSelections of [[], Array.from({ length: 33 }, () => h.selections[0]),
    [{ ...h.selections[0], byteDigest: 'unretained' }],
    [{ ...h.selections[0], variantId: h.resource }], [{ ...h.selections[0], revisionId: h.revision }]]) {
    expect(Value.Check(resolvedTarget, { ...target, contentSelections })).toBe(false);
  }
});
