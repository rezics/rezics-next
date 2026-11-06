import { admitFilter, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import { routeOf } from '../route/route.ts';
import { compileFilter } from './filter.ts';
import { discoveryIndexUuid, subjectGenerations, subjectIndexName } from './indices.ts';
import type { OpenSearch, SearchRequestWork } from './opensearch.ts';
import { SearchUnavailableError } from './opensearch.ts';
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

/** Current public generation, physical identity and accepted release. Changed evidence restarts. */
export async function observeCataloguePublication(
  input: CataloguePublicationObserve,
): Promise<Pick<CataloguePublicationPage, 'observation' | 'work' | 'engineRequests'>> {
  const meter = new CataloguePublicationMeter(input.work, input.deadline);
  meter.reserve({ nativePoints: ENGINE_POINTS, statements: ENGINE_CALLS - 1 });
  const digest = input.releaseDigest;
  if (typeof digest !== 'string' || digest.length === 0) unavailable('Catalogue publication release is missing');
  const generations = await subjectGenerations(input.client, input.prefix, meter.engine());
  if (generations.active === null) unavailable('Catalogue publication has no active generation');
  const generation = generations.active;
  const index = subjectIndexName(input.prefix, generation);
  const uuid = await discoveryIndexUuid(input.client, index, meter.engine());
  const observation: CataloguePublicationObservation = { releaseDigest: digest, generation, uuid, index };
  if (input.expected && !sameObservation(input.expected, observation))
    unavailable('Catalogue publication generation changed');
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
  const digest = input.releaseDigest;
  if (typeof digest !== 'string' || digest.length === 0) unavailable('Catalogue publication release is missing');
  const generations = await subjectGenerations(input.client, input.prefix, meter.engine());
  if (generations.active === null) unavailable('Catalogue publication has no active generation');
  const generation = generations.active;
  const index = subjectIndexName(input.prefix, generation);
  const uuid = await discoveryIndexUuid(input.client, index, meter.engine());
  const observation: CataloguePublicationObservation = { releaseDigest: digest, generation, uuid, index };
  if (input.expected && !sameObservation(input.expected, observation))
    unavailable('Catalogue publication generation changed');
  const filter = admitFilter(parseFilter(input.filter), input.release);
  const compiled = compileFilter(filter, { prefix: 'c' });
  const overflowProperties = [
    ...new Set(compiled.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
  ];
  const result = await searchSubjectHits(input.client, input.prefix, {
    sort: 'id',
    filter: compiled.query,
    size,
    generation,
    ...(input.after === null ? {} : { after: [input.after] }),
    overflowProperties,
    work: meter.engine(),
  });
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hit of result.hits.slice(0, input.limit)) {
    if (seen.has(hit.id) || routeOf(hit.id) === null) continue;
    if (unique.length && hit.id <= unique.at(-1)!) throw new TypeError('Catalogue publication order is not canonical');
    seen.add(hit.id);
    unique.push(hit.id);
  }
  return {
    subjects: unique,
    exhausted: result.hits.length <= input.limit,
    observation,
    ...meter.page(),
  };
}
