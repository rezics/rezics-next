import { randomUUID } from 'node:crypto';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import type { CataloguePort } from './load.ts';

const short = (iri: string) => iri.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;

export async function catalogueRequest<T>(port: CataloguePort, method: string, path: string,
  body?: object, status = 200, key: string = randomUUID()): Promise<T> {
  const response = await port.request(method, path, body, key);
  if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body as T;
}

export async function catalogueCollection(port: CataloguePort, name: string, members: string[]) {
  const collection = native();
  await port.grant(`collection:edit:${collection}`, 'collection.edit');
  await port.grant(`semantic:read:${collection}`, 'semantic.read');
  const created = await catalogueRequest<{ structure: string; revision: string }>(port, 'POST', '/v1/collections',
    { collection, name, language: 'en', disclosure: 'public', actingSubject: port.actingSubject }, 201);
  if (members.length) await catalogueRequest(port, 'POST', `/v1/collections/${short(collection)}/changes`, {
    expectedHead: created.revision, actingSubject: port.actingSubject,
    operations: members.map(target => ({ op: 'insert', role: 'member', parent: created.structure,
      position: 'last', target })) });
  return collection;
}

export async function catalogueZone(port: CataloguePort, name: string, mounts: Record<string, string>) {
  await port.grant('space:create:root', 'space.create');
  const space = await catalogueRequest<{ space: string; realm: string }>(port, 'POST', '/v1/spaces', {
    profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: port.actingSubject }, 201);
  const zone = native();
  await port.grant(`zone:edit:${zone}`, 'zone.edit');
  await port.grant(`semantic:read:${zone}`, 'semantic.read');
  let navigation = await catalogueRequest<{ revision: string }>(port, 'POST', '/v1/zones', {
    zone, space: space.space, disclosure: 'public', actingSubject: port.actingSubject }, 201);
  for (const [routeSegment, target] of Object.entries(mounts)) {
    navigation = await catalogueRequest(port, 'POST', `/v1/zones/${short(zone)}/mounts`, {
      expectedHead: navigation.revision, target, routeSegment, position: 'last', disclosure: 'public',
      actingSubject: port.actingSubject });
  }
  return { zone, ...space };
}

/** Reuse a series' volume occurrences. A leaf Work gets two synthetic chapters;
 * adding a second Structure to a series would make its reading order ambiguous. */
export async function cataloguePositions(port: CataloguePort, work: string, mainVersion: string) {
  const existing = await catalogueRequest<{ items: { occurrence: string }[] }>(port, 'GET',
    `/v1/reading-positions/${short(work)}?actingSubject=${encodeURIComponent(port.actingSubject)}&position=all`);
  if (existing.items.length) return { occurrences: existing.items.map(item => item.occurrence) };
  const base = await catalogueRequest<{ structure: string; revision: string }>(port, 'POST', '/v1/compositions', {
    profile: 'book-composition', work, mainVersion, actingSubject: port.actingSubject }, 201);
  return catalogueRequest<{ structure: string; revision: string; occurrences: string[] }>(port, 'POST',
    `/v1/compositions/${short(base.structure)}/changes`, { profile: 'book-composition', expectedHead: base.revision,
      actingSubject: port.actingSubject, operations: [1, 2].map(index => ({ op: 'insert', role: 'chapter',
        parent: base.structure, position: 'last', target: 'https://schema.org/DigitalDocument',
        label: { value: `Fixture chapter ${index}`, language: 'en' } })) });
}

/** Both submission and steward approval use the public editorial API. A claim's
 * applicability and revelation position are committed by the wiki owner. */
export async function publishCatalogueFact(submitter: CataloguePort, steward: CataloguePort,
  input: { work: string; zone: string; subject: string; predicate: string; text: string; occurrences: string[] }) {
  const head = await catalogueRequest<{ revision: string }>(submitter, 'GET',
    `/v1/works/${short(input.work)}?actingSubject=${encodeURIComponent(submitter.actingSubject)}`);
  const source = { representationSha256: 'c'.repeat(64), mediaType: 'text/plain', language: 'en',
    rightsBasis: 'original_contribution' as const,
    method: { agent: 'Catalogue fixture', model: 'synthetic', inference: 'local' as const } };
  const bundle: WikiExtraction = { profile: 'wiki-extraction-v1', target: input.work, continuity: input.work,
    zone: input.zone, source, entities: [],
    units: input.occurrences.map((occurrence, index) => ({ id: `ch${index + 1}`, ordinal: index,
      label: `Fixture chapter ${index + 1}`, occurrence })),
    claims: [{ subject: input.subject, predicate: input.predicate, object: { kind: 'literal', value: input.text, language: 'en' },
      modality: 'narrated', continuity: input.work, revealedAt: `ch${input.occurrences.length}`, evidence: [{ quote: input.text,
        locator: { version: 'rezics-locator-v1', source: { type: 'external',
          representationSha256: source.representationSha256, mediaType: source.mediaType },
        selector: { type: 'TextQuoteSelector', exact: input.text } } }] }] };
  const proposal = await catalogueRequest<{ proposal: string; revision: number }>(submitter, 'POST', '/v1/editorial/proposals', {
    profile: 'editorial-proposal-create-v1', kind: 'wiki-bundle',
    target: { resource: input.work, revision: head.revision, context: 'urn:rezics:context:global' }, candidate: bundle,
    baseHeads: [{ component: input.work, head: head.revision }], evidence: [], actingSubject: submitter.actingSubject }, 201);
  const key = randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await steward.request('POST', `/v1/editorial/proposals/${proposal.proposal}/decisions`, {
      profile: 'editorial-proposal-decide-v1', revision: proposal.revision, outcome: 'applied', approve: true,
      message: 'Checked the synthetic continuity and chapter boundary', actingSubject: steward.actingSubject }, key);
    if (response.status !== 200 && response.status !== 202) throw new Error(`Wiki decision: ${response.status} ${JSON.stringify(response.body)}`);
    const result = response.body as { receipt?: OwnerReceipt };
    if (result.receipt) {
      const claim = result.receipt.commands?.find(command => command.key.endsWith(':claim:0'));
      if (claim?.outcome !== 'applied') throw new Error(`Wiki claim did not apply: ${JSON.stringify(result.receipt)}`);
      return (claim.result as { component: string }).component;
    }
  }
  throw new Error('Wiki publication did not finish its bounded deliveries');
}
