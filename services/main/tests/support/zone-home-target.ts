import { randomUUID } from 'node:crypto';
import { configureDisclosure, type DisclosureTarget } from '../../src/modules/disclosure/read.ts';
import { compositionReceiptIri } from '../../src/modules/structure/change.ts';
import { zonePublishedPageBinding } from '../../src/modules/zone/config-format.ts';
import { RV, type WorkActivationEnvironment } from '../../src/modules/work/activate.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './disclosure-ancestry.ts';
import type { DisclosureReader } from '../../src/modules/disclosure/read.ts';

export const zoneHomeTargetId = () => `https://rezics.com/id/${randomUUID()}`;
export const zoneHomeTargetCell = (value: string) => ({ type: 'literal', value });
type Row = Record<string, { type: string; value: string }>;
export function configureZoneHomeDisclosure(env: WorkActivationEnvironment, reader: Pick<DisclosureReader, 'read'>) {
  configureDisclosure(env, fixtureDisclosureReader(reader.read));
}

export function zoneHomeTargetFixture(options: { ancestry?: boolean } = {}) {
  const resource = zoneHomeTargetId(), zone = zoneHomeTargetId(), revision = zoneHomeTargetId(), siteRevision = zoneHomeTargetId(), space = zoneHomeTargetId(), author = zoneHomeTargetId();
  const epoch = randomUUID(), admission = randomUUID();
  const receipt = compositionReceiptIri(admission, 'zone.edit');
  const selections = ['en', 'fr'].map(language => ({ revisionId: randomUUID(),
    variantId: `urn:rezics:variant:${randomUUID()}`, byteDigest: (language === 'en' ? 'a' : 'b').repeat(64), language }));
  const fields = { zone, revision: siteRevision, routesRevision: zoneHomeTargetId(), navigationRevision: zoneHomeTargetId(), themeRevision: zoneHomeTargetId(),
    count: '2', admissionId: admission, digest: 'c'.repeat(64), authorityEpoch: '1', scope: `zone:edit:${zone}`,
    dataEpoch: epoch, sequence: '9', homeDocument: resource, homeRevision: revision };
  const rows: Row[] = selections.map(selection => Object.fromEntries(Object.entries({ ...fields,
    binding: zonePublishedPageBinding(siteRevision, resource, selection.revisionId), page: resource,
    variant: selection.variantId, contentRevision: `urn:rezics:content:revision:${selection.revisionId}`,
    byteDigest: selection.byteDigest, language: selection.language }).map(([key, value]) => [key, zoneHomeTargetCell(value)])));
  const ownerRows: Row[] = [{ zone: zoneHomeTargetCell(zone), head: zoneHomeTargetCell(revision), typed: zoneHomeTargetCell('true'), space: zoneHomeTargetCell(space), author: zoneHomeTargetCell(author) }];
  const cutRows: Row[] = [{ receipt: zoneHomeTargetCell(receipt), siteRevision: zoneHomeTargetCell(siteRevision) }];
  const visibilityRows: Row[] = [{ kind: zoneHomeTargetCell('space'), space: zoneHomeTargetCell(space), disclosure: zoneHomeTargetCell(`${RV}Public`) }];
  const queries: string[] = [], policyTargets: DisclosureTarget[][] = [];
  let denied = false;
  const env = { lineage: { dataEpoch: epoch, routingEpoch: randomUUID() },
    fuseki: { query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT DISTINCT ?zone ?head ?typed')) return { results: { bindings: ownerRows } };
      if (query.includes('SELECT DISTINCT ?receipt ?siteRevision')) return { results: { bindings: cutRows } };
      if (query.includes('?target ?kind ?space ?realm ?disclosure')) return { results: {
        bindings: visibilityRows.map(row => ({ ...row, target: zoneHomeTargetCell(zone) })),
      } };
      if (query.includes('?kind ?space ?realm ?disclosure')) return { results: { bindings: visibilityRows } };
      if (query.includes('SELECT ?zone ?revision ?routesRevision')) return { results: { bindings: rows } };
      if (query.includes('SELECT ?target WHERE')) return { results: { bindings: [] } };
      if (query.includes('SELECT DISTINCT ?kind ?head')) return { results: { bindings: [{ kind: { type: 'uri', value: `${RV}Space` } }] } };
      if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
        return { results: { bindings: [{ work: zoneHomeTargetCell(resource) }] } };
      }
      if (query.includes('ASK')) return { boolean: !query.includes('a rv:ErasedRevision') || query.includes('FILTER NOT EXISTS') };
      throw new Error(`Unexpected owner probe: ${query}`);
    } } } as unknown as WorkActivationEnvironment;
  if (options.ancestry !== false) configureFixtureDisclosureAncestry(env, () => undefined);
  configureZoneHomeDisclosure(env, { read: async targets => {
    policyTargets.push(targets.map(({ ancestry: _ancestry, ...target }) => target));
    return targets.map(() => denied ? 'hidden' : 'visible');
  } });
  return { env, resource, zone, revision, siteRevision, space, author, selections, ownerRows, cutRows,
    visibilityRows, rows, queries, policyTargets, deny: (value: boolean) => { denied = value; } };
}

