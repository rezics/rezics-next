import { admitFilter, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import { routeOf } from '../route/route.ts';
import { compileFilter } from './filter.ts';
import { discoveryIndexUuid, subjectGenerations, subjectIndexName } from './indices.ts';
import type { OpenSearch, SearchRequestWork } from './opensearch.ts';
import { OpenSearchError, SearchUnavailableError } from './opensearch.ts';
import { searchSubjectHits } from './query.ts';
import { zeroScopeWork } from './scope-work.ts';

export type CataloguePublicationObservation = Readonly<{
  releaseDigest: string;
  generation: number;
  uuid: string;
  index: string;
}>;

export type CataloguePublicationPage = Readonly<{
  subjects: readonly string[];
  exhausted: boolean;
  observation: CataloguePublicationObservation;
  work: WorkReceipt;
  engineRequests: number;
}>;

export type CataloguePublicationRead = Readonly<{
  client: OpenSearch;
  prefix: string;
  filter: FilterDocument;
  release: FilterRelease;
  releaseDigest: string;
  after: string | null;
  limit: number;
  deadline: number;
  work: WorkAllowance;
  expected?: CataloguePublicationObservation;
}>;

export type CataloguePublicationObserve = Readonly<{
  client: OpenSearch;
  prefix: string;
  releaseDigest: string;
  deadline: number;
  work: WorkAllowance;
  expected?: CataloguePublicationObservation;
}>;

export type CataloguePublicationLookup = CataloguePublicationRead &
  Readonly<{
    selected: readonly string[];
  }>;

export type CataloguePublicationLookupPage = Readonly<{
  present: readonly string[];
  missing: readonly string[];
  observation: CataloguePublicationObservation;
  work: WorkReceipt;
  engineRequests: number;
}>;

const LOOKAHEAD = 1;
const ENGINE_CALLS = 3;
const ENGINE_POINTS = 2;
const MAX_PAGE = 100;

function unavailable(message = 'Catalogue publication observation is unavailable'): never {
  throw new SearchUnavailableError(message);
}

function sameObservation(left: CataloguePublicationObservation, right: CataloguePublicationObservation): boolean {
  return (
    left.releaseDigest === right.releaseDigest &&
    left.generation === right.generation &&
    left.uuid === right.uuid &&
    left.index === right.index
  );
}

function uncertainTransport(error: unknown): boolean {
  return error instanceof SearchUnavailableError || error instanceof OpenSearchError;
}

class CataloguePublicationMeter {
  private readonly spent = { ...zeroScopeWork() };
  private engines = 0;
  constructor(
    private readonly allowance: WorkAllowance,
    private readonly deadline: number,
  ) {
    if (!allowance.reservationId) throw new TypeError('Catalogue publication reservation is missing');
    if (!Number.isFinite(deadline) || deadline <= Date.now()) unavailable('Catalogue publication deadline has passed');
    for (const axis of Object.keys(this.spent) as (keyof typeof this.spent)[])
      if (!Number.isSafeInteger(allowance.remaining[axis]) || allowance.remaining[axis] < 0)
        throw new RangeError('Catalogue publication reservation is invalid');
  }

  remaining(axis: keyof typeof this.spent): number {
    return this.allowance.remaining[axis] - this.spent[axis];
  }

  reserve(used: Partial<typeof this.spent>): void {
    const next = { ...zeroScopeWork(), ...used };
    for (const axis of Object.keys(this.spent) as (keyof typeof this.spent)[]) {
      if (!Number.isSafeInteger(next[axis]) || next[axis] < 0)
        throw new RangeError('Catalogue publication work is invalid');
      if (next[axis] > this.remaining(axis)) unavailable('Catalogue publication work exceeded its reservation');
    }
    for (const axis of Object.keys(this.spent) as (keyof typeof this.spent)[]) this.spent[axis] += next[axis];
  }

  engine(): SearchRequestWork {
    if (Date.now() >= this.deadline) unavailable('Catalogue publication deadline has passed');
    const budget = this.remaining('bytes');
    if (budget < 2) unavailable('Catalogue publication byte reservation is exhausted');
    this.engines += 1;
    return {
      bytes: budget,
      deadline: this.deadline,
      settle: (bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new RangeError('Catalogue publication settled bytes are invalid');
        this.reserve({ bytes });
      },
    };
  }

  page(): Pick<CataloguePublicationPage, 'work' | 'engineRequests'> {
    return {
      engineRequests: this.engines,
      work: { reservationId: this.allowance.reservationId, used: { ...this.spent } },
    };
  }
}

async function readObservation(
  input: Pick<CataloguePublicationObserve, 'client' | 'prefix' | 'releaseDigest'>,
  meter: CataloguePublicationMeter,
): Promise<CataloguePublicationObservation> {
  const digest = input.releaseDigest;
  if (typeof digest !== 'string' || digest.length === 0) unavailable('Catalogue publication release is missing');
  const generations = await subjectGenerations(input.client, input.prefix, meter.engine());
  if (generations.active === null) unavailable('Catalogue publication has no active generation');
  const generation = generations.active;
  const index = subjectIndexName(input.prefix, generation);
  const uuid = await discoveryIndexUuid(input.client, index, meter.engine());
  return { releaseDigest: digest, generation, uuid, index };
}

/**
 * A lost engine response keeps the publication attempt open: re-read the native generation/uuid/index and retry
 * the same call while that selected public observation is unchanged. Working-draft metadata cannot replace it.
 */
async function reconcileCatalogueCall<T>(
  meter: CataloguePublicationMeter,
  input: Pick<CataloguePublicationObserve, 'client' | 'prefix' | 'releaseDigest'>,
  expected: CataloguePublicationObservation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!uncertainTransport(error)) throw error;
    meter.reserve({ statements: 3, nativePoints: ENGINE_POINTS });
    const current = await readObservation(input, meter);
    if (!sameObservation(expected, current)) unavailable('Catalogue publication generation changed');
    return await run();
  }
}

async function pinObservation(
  input: CataloguePublicationObserve,
  meter: CataloguePublicationMeter,
): Promise<CataloguePublicationObservation> {
  let observation: CataloguePublicationObservation;
  try {
    observation = await readObservation(input, meter);
  } catch (error) {
    if (!uncertainTransport(error) || !input.expected) throw error;
    meter.reserve({ statements: 2, nativePoints: ENGINE_POINTS });
    observation = await readObservation(input, meter);
    if (!sameObservation(input.expected, observation)) unavailable('Catalogue publication generation changed');
  }
  if (input.expected && !sameObservation(input.expected, observation))
    unavailable('Catalogue publication generation changed');
  return observation;
}

function canonicalSubjects(hits: readonly { id: string }[], limit: number): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits.slice(0, limit)) {
    if (seen.has(hit.id) || routeOf(hit.id) === null) continue;
    if (unique.length && hit.id <= unique.at(-1)!) throw new TypeError('Catalogue publication order is not canonical');
    seen.add(hit.id);
    unique.push(hit.id);
  }
  return unique;
}

async function searchPinnedPage(
  input: CataloguePublicationRead,
  meter: CataloguePublicationMeter,
  observation: CataloguePublicationObservation,
  size: number,
) {
  const filter = admitFilter(parseFilter(input.filter), input.release);
  const compiled = compileFilter(filter, { prefix: 'c' });
  const overflowProperties = [
    ...new Set(compiled.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
  ];
  return reconcileCatalogueCall(meter, input, observation, () =>
    searchSubjectHits(input.client, input.prefix, {
      sort: 'id',
      filter: compiled.query,
      size,
      generation: observation.generation,
      ...(input.after === null ? {} : { after: [input.after] }),
      overflowProperties,
      work: meter.engine(),
    }),
  );
}

/** Current public generation, physical identity and accepted release. Changed evidence restarts. */
export async function observeCataloguePublication(
  input: CataloguePublicationObserve,
): Promise<Pick<CataloguePublicationPage, 'observation' | 'work' | 'engineRequests'>> {
  const meter = new CataloguePublicationMeter(input.work, input.deadline);
  meter.reserve({ nativePoints: ENGINE_POINTS, statements: ENGINE_CALLS - 1 });
  const observation = await pinObservation(input, meter);
  return { observation, ...meter.page() };
}

/** Search public producer: selected catalogue A for Library staging. Library facts never enter this population. */
export async function readCataloguePublicationPage(input: CataloguePublicationRead): Promise<CataloguePublicationPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE)
    throw new RangeError('Catalogue publication page exceeds its bound');
  if (input.after !== null && routeOf(input.after) === null)
    throw new TypeError('Catalogue publication continuation is not a canonical identity');
  const size = input.limit + LOOKAHEAD;
  const meter = new CataloguePublicationMeter(input.work, input.deadline);
  if (meter.remaining('candidateKeys') < size) unavailable('Catalogue publication lookahead exceeds its reservation');
  meter.reserve({ nativePoints: ENGINE_POINTS, statements: ENGINE_CALLS, candidateKeys: size });
  const observation = await pinObservation(input, meter);
  const result = await searchPinnedPage(input, meter, observation, size);
  return {
    subjects: canonicalSubjects(result.hits, input.limit),
    exhausted: result.hits.length <= input.limit,
    observation,
    ...meter.page(),
  };
}

/**
 * Lookup the explicitly selected public A through its pinned native observation. The stored selected
 * identities are the render set; a later working B or a live index append is not this selection.
 */
export async function lookupCataloguePublication(
  input: CataloguePublicationLookup,
): Promise<CataloguePublicationLookupPage> {
  if (input.expected === undefined) unavailable('Catalogue publication selection is missing');
  const selected: string[] = [];
  for (const id of input.selected) {
    if (routeOf(id) === null) throw new TypeError('Catalogue publication lookup is not a canonical identity');
    if (selected.length && id <= selected.at(-1)!)
      throw new TypeError('Catalogue publication lookup order is not canonical');
    selected.push(id);
  }
  const observed = await observeCataloguePublication(input);
  return {
    present: selected,
    missing: [],
    observation: observed.observation,
    work: observed.work,
    engineRequests: observed.engineRequests,
  };
}

/** Selected A reread: the pinned observation is required so a working draft cannot stand in for it. */
export async function readSelectedCataloguePublicationPage(
  input: CataloguePublicationRead & { expected: CataloguePublicationObservation },
): Promise<CataloguePublicationPage> {
  return readCataloguePublicationPage(input);
}
