import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
import type { FacetScopeCursorBinding } from './facet-discovery-contract.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding } from './cursor.ts';
import type { FacetDiscovery200Response, FacetDiscoveryValue } from './facet-discovery-contract.ts';
import type { FacetDiscoveryProvider, FacetNativePlan, FacetNativeRead } from './facet-discovery-native.ts';
import { codeFacet, typeFacetLabels, type Facet } from './facets.ts';
import { chooseTexts } from './hits.ts';
import type { TextNode } from './text.ts';
import { scopedFacetIdentityKey, type ScopedFacetAdmission } from './scoped-facet-source.ts';

const operation = 'POST /v1/subjects:facets';
const ready = () => new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
const restart = () => new ProblemError('search_restart_required');
const compare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

type Position = Readonly<{
  observation: string;
  build: string;
  generation: string;
  key: string;
  searchGeneration: number;
  source: string;
  consumer: string;
  release: string;
}>;

export type FacetDiscoveryInput = Readonly<{
  principal: 'anonymous' | `account:${string}`;
  text: TextNode | undefined;
  filter: FilterDocument | undefined;
  originalFilter: FilterDocument | undefined;
  release: FilterRelease;
  facets: readonly Facet[];
  languages: readonly string[] | undefined;
  now: number;
  context: PublicFilterConsumerContext;
  /** Internal request supplied by the Realm/Collection admission owner; absent from the facet wire DTO. */
  scope?: ScopedFacetAdmission;
  scopeBinding?: FacetScopeCursorBinding;
}>;

function invalid(index: number): never {
  throw new ProblemError('invalid_request', {
    errors: [{ pointer: `/facets/${index}/cursor`, code: 'invalid_format' }],
  });
}

/** Syntax and whole-page reservation happen before any Source, engine or native capture I/O. */
export function admitFacetPage(facets: readonly Facet[]) {
  const slots = facets.reduce((sum, facet) => sum + facet.size, 0);
  if (slots > 128)
    throw new ProblemError('unsupported_query', { errors: [{ pointer: '/facets', code: 'unsupported' }] });
  const candidates = facets.reduce((sum, facet) => sum + 2 * facet.size + 2, 0);
  return {
    slots,
    candidates,
    points: 16 * facets.length + 8 * candidates,
    rows: 64 * facets.length + 16 * candidates,
    engineReads: 2 * facets.length,
    statements: 8 + 4 * facets.length,
  };
}

export type FacetCursorInput = Pick<
  FacetDiscoveryInput,
  'principal' | 'text' | 'originalFilter' | 'languages' | 'facets' | 'now' | 'scopeBinding'
>;
export function facetCursorReleaseBinding(release: FilterRelease, scopeBinding?: FacetScopeCursorBinding): string {
  const canonical = canonicalize(scopeBinding ? { release, admission: scopeBinding.admission } : release);
  if (canonical === undefined) throw ready();
  return createHash('sha256').update(canonical).digest('hex');
}

export function facetCursorBinding(input: FacetCursorInput, facet: Facet): SearchCursorBinding {
  return {
    operation,
    principal: input.principal,
    request: {
      text: input.text ?? null,
      filter: input.originalFilter ?? null,
      property: facet.property,
      languages: input.languages ?? null,
      size: facet.size,
      ...(input.scopeBinding ? { scope: input.scopeBinding.request } : {}),
    },
  };
}

async function position(
  ring: KeyRing,
  input: FacetCursorInput,
  facet: Facet,
  index: number,
): Promise<Position | undefined> {
  if (facet.cursor === undefined) return undefined;
  const decoded = await decodeSearchCursor(ring, facetCursorBinding(input, facet), facet.cursor, input.now);
  if (!decoded.ok) {
    if (decoded.reason === 'expired') throw restart();
    invalid(index);
  }
  const [version, observation, build, generation, key, source, consumer, release] = decoded.after;
  if (
    decoded.after.length !== 8 ||
    version !== 'facet-v3' ||
    typeof observation !== 'string' ||
    !observation ||
    typeof build !== 'string' ||
    !build ||
    typeof generation !== 'string' ||
    !/^[1-9][0-9]*$/.test(generation) ||
    typeof key !== 'string' ||
    !key ||
    !key.isWellFormed() ||
    typeof source !== 'string' ||
    !source ||
    typeof consumer !== 'string' ||
    !/^[0-9a-f]{64}$/.test(consumer) ||
    typeof release !== 'string' ||
    !/^[0-9a-f]{64}$/.test(release)
  )
    invalid(index);
  return {
    observation,
    build,
    generation,
    key,
    source,
    consumer,
    release,
    searchGeneration: decoded.generation,
  };
}

/** Authenticate original static query/principal before reading changing meaning or runtime availability. */
export async function authenticateFacetCursors(ring: KeyRing, input: FacetCursorInput) {
  const positions: (Position | undefined)[] = [];
  for (const [index, facet] of input.facets.entries()) positions.push(await position(ring, input, facet, index));
  return positions;
}
export function validateFacetCursorRelease(
  positions: readonly (Position | undefined)[],
  release: FilterRelease,
  scopeBinding?: FacetScopeCursorBinding,
) {
  if (positions.some((previous) => previous && previous.release !== facetCursorReleaseBinding(release, scopeBinding)))
    throw restart();
}

// Native registration includes physical incarnation, complete meaning and the registered read definition.
// Keep that context confidential and fixed-size under the existing Search cursor profile.
function consumerBinding(read: FacetNativeRead): string {
  const canonical = canonicalize({
    consumer: read.queried.consumer,
    meaning: read.plan.meaning.digest,
    ...(read.plan.scope ? { scope: scopedFacetIdentityKey(read.plan.scope.identity) } : {}),
  });
  if (canonical === undefined) throw ready();
  return createHash('sha256').update(canonical).digest('hex');
}

/** Inclusive diagnostic admission: no retry or sibling gets a fresh copy of the common ledger.
 * The native producer still enforces actual SQL/bytes/connection ceilings; these counters cannot certify it.
 */
function ledger(facets: readonly Facet[]) {
  const budget = admitFacetPage(facets);
  const totals: { -readonly [K in keyof PublicFilterCost]: number } = {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
  return (cost: PublicFilterCost) => {
    for (const key of Object.keys(totals) as (keyof PublicFilterCost)[]) {
      if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) throw ready();
      totals[key] += cost[key];
      if (!Number.isSafeInteger(totals[key])) throw ready();
    }
    if (
      totals.candidates > budget.candidates ||
      totals.accessPoints + totals.dependencyPoints > budget.points ||
      totals.engineSearches > budget.engineReads ||
      totals.outputSlots > budget.slots
    )
      throw ready();
  };
}

function values(
  entries: readonly FacetDiscoveryValue[],
  read: FacetNativeRead,
  release: FilterRelease,
  languages: readonly string[] | undefined,
): FacetDiscoveryValue[] {
  let previous = read.after;
  return entries.map((entry) => {
    if (
      typeof entry.value !== 'string' ||
      !entry.value ||
      !entry.value.isWellFormed() ||
      (previous !== null && compare(previous, entry.value) >= 0)
    )
      throw ready();
    if (
      read.plan.valueKind === 'item' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.value)
    )
      throw ready();
    previous = entry.value;
    const available = read.plan.valueKind === 'type' ? typeFacetLabels(release, entry.value) : entry.labels;
    if (!available || Object.values(available).some((label) => typeof label !== 'string')) throw ready();
    // Only native current eligible labels reach this boundary. Language choice adds no permission.
    const labels =
      read.plan.valueKind === 'code'
        ? {}
        : chooseTexts(
            Object.entries(available).map(([language, value]) => ({ language, value })),
            languages,
            undefined,
          );
    return { value: entry.value, labels };
  });
}

/** Consume actual native capture/page operations. There is no preview, sampler or returned-row safety fallback.
 * Capture deduplicates durable builds; only immutable prepared observations may reach pageFacets.
 * Native pageFacets is the single shared START/final protocol, not one separately budgeted call per property.
 */
export async function readFacetDiscovery(
  ring: KeyRing,
  provider: FacetDiscoveryProvider,
  input: FacetDiscoveryInput,
  positions: readonly (Position | undefined)[],
): Promise<FacetDiscovery200Response> {
  const charge = ledger(input.facets);
  const checkDeadline = () => {
    if (Date.now() >= input.context.deadline) throw new ProblemError('deadline_exceeded');
  };
  checkDeadline();
  const scopeIdentity = input.scope ? scopedFacetIdentityKey(input.scope.identity) : undefined;
  if (input.scope !== undefined && input.scopeBinding?.admission !== scopeIdentity) throw ready();
  if (input.scope === undefined && input.scopeBinding !== undefined) throw ready();
  validateFacetCursorRelease(positions, input.release, input.scopeBinding);
  if (!Number.isSafeInteger(provider.generation) || provider.generation < 1 || !provider.source) throw ready();
  if (positions.some((previous) => previous && previous.source !== provider.source)) throw restart();
  if (canonicalize(provider.meaning.release) !== canonicalize(input.release)) {
    if (positions.some(Boolean)) throw restart();
    throw ready();
  }
  const reads: FacetNativeRead[] = [];
  let preparing = false;
  for (const [index, facet] of input.facets.entries()) {
    checkDeadline();
    const plan: FacetNativePlan = {
      filterDocument: input.filter,
      text: input.text,
      property: facet.property,
      valueKind: facet.property === 'type' ? 'type' : codeFacet(input.release, facet.property) ? 'code' : 'item',
      meaning: provider.meaning,
      ...(input.scope ? { scope: input.scope } : {}),
    };
    const captured = await provider.operations.captureFacet({ plan }, input.context);
    charge(captured.cost);
    if (captured.status !== 'captured') {
      if (
        captured.status === 'unready' &&
        ['incarnation_changed', 'observation_lost'].includes(captured.reason) &&
        positions[index]
      )
        throw restart();
      preparing = true;
      continue;
    }
    const snapshot = captured.queried.snapshot;
    // Direct admission is deliberately closed until its independent native proof exists.
    if (snapshot.kind !== 'prepared') throw ready();
    const previous = positions[index];
    if (
      previous &&
      (previous.searchGeneration !== provider.generation ||
        previous.observation !== snapshot.observation ||
        previous.build !== snapshot.build ||
        previous.generation !== snapshot.generation.toString())
    )
      throw restart();
    const read = { plan, queried: captured.queried, size: facet.size, after: previous?.key ?? null };
    if (previous && previous.consumer !== consumerBinding(read)) throw restart();
    reads.push(read);
  }
  if (preparing || reads.length !== input.facets.length) throw ready();
  checkDeadline();
  const page = await provider.operations.pageFacets({ reads }, input.context);
  charge(page.cost);
  if (page.status !== 'ready') {
    if (
      page.status === 'unready' &&
      ['incarnation_changed', 'observation_lost'].includes(page.reason) &&
      positions.some(Boolean)
    )
      throw restart();
    throw ready();
  }
  if (page.facets.length !== reads.length || !Number.isFinite(Date.parse(page.asOf))) throw ready();
  // Validate every sibling before producing any confidential token. Nothing is published on a failed sibling.
  const result = page.facets.map((facet, index) => {
    const read = reads[index]!;
    if (
      facet.property !== read.plan.property ||
      facet.values.length > read.size ||
      (facet.hasMore && facet.values.length !== read.size) ||
      (read.after !== null && facet.values.length === 0)
    )
      throw ready();
    const selected = values(facet.values, read, input.release, input.languages);
    const last = selected.at(-1)?.value ?? null;
    if (facet.after !== last) throw ready();
    return { property: facet.property, values: selected, next: null as string | null };
  });
  for (const [index, facet] of page.facets.entries()) {
    if (!facet.hasMore) continue;
    const snapshot = reads[index]!.queried.snapshot;
    if (snapshot.kind !== 'prepared' || facet.after === null) throw ready();
    result[index]!.next = await encodeSearchCursor(
      ring,
      facetCursorBinding(input, input.facets[index]!),
      {
        generation: provider.generation,
        after: [
          'facet-v3',
          snapshot.observation,
          snapshot.build,
          snapshot.generation.toString(),
          facet.after,
          provider.source,
          consumerBinding(reads[index]!, input.scopeBinding),
          facetCursorReleaseBinding(input.release, input.scopeBinding),
        ],
      },
      input.now,
    );
  }
  checkDeadline();
  return { facets: result, as_of: page.asOf };
}
