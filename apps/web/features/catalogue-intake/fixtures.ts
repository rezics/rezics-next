import type { Candidate, CreateAnswer, HeaderMark, IntakePort, OwnerAnswer, SearchInput, SearchState } from './intake.ts';

// Records the stories and tests share: the Sword Art Online records the catalogue search finds by
// its Japanese title, its romaji or its English title.

const iri = (n: number) => `https://rezics.com/id/01944300-0000-7000-8000-${String(n).padStart(12, '0')}`;
const head = iri(900);

const candidate = (n: number, attributes: Candidate['attributes']): Candidate =>
  ({ work: iri(n), mainVersion: iri(n + 100), revision: head, attributes });

export const series: Candidate = candidate(1, [
  { field: 'title', value: 'Sword Art Online', language: 'en' },
  { field: 'grain', value: 'work', language: null },
  { field: 'alias', value: 'ソードアート・オンライン', language: 'ja' },
  { field: 'alias', value: 'Sōdo Āto Onrain', language: 'ja-Latn' },
  { field: 'creator', value: 'Reki Kawahara', language: null },
]);
export const volumeOne: Candidate = candidate(2, [
  { field: 'title', value: 'Sword Art Online, Vol. 1', language: 'en' },
  { field: 'grain', value: 'work', language: null },
  { field: 'alias', value: 'ソードアート・オンライン 1', language: 'ja' },
  { field: 'creator', value: 'Reki Kawahara', language: null },
]);
export const pending: Candidate = candidate(3, [
  { field: 'title', value: 'Sword Art Online: Progressive', language: 'en' },
  { field: 'grain', value: 'new-creative-scope', language: null },
  { field: 'verification', value: 'unverified', language: null },
]);
export const candidates = [series, volumeOne, pending] as const;

export const receipt = '5d7c3a52-0b50-4b1f-9a39-2b5e7a0d4f10';
export const actingSubject = 'https://rezics.com/id/01944300-0000-7000-8000-000000000a01';
export const createdWork = iri(77);

export const marked: HeaderMark = { verification: 'unverified', provenance: { contributor: actingSubject,
  candidateReceipt: receipt, fields: ['title', 'language', 'grain', 'semanticTypes'] } };

export const found = (input: SearchInput, list: readonly Candidate[] = candidates): SearchState =>
  ({ phase: 'found', input, receipt, candidates: list });

export interface PortScript {
  search?: (input: SearchInput) => Promise<SearchState>;
  ownerApi?: (grain: string) => Promise<OwnerAnswer>;
  create?: (parentComposition: string | null) => Promise<CreateAnswer>;
  provenance?: () => Promise<HeaderMark | null>;
}

/** A port that answers from a script and records every call, so a test can say what was asked and in what order. */
export function scriptedPort(script: PortScript = {}): IntakePort & { calls: string[] } {
  const calls: string[] = [];
  return { calls,
    async search(input) { calls.push(`search:${input.text}`); return script.search ? script.search(input) : found(input); },
    async ownerApi(grain) {
      calls.push(`owner:${grain}`);
      return script.ownerApi ? script.ownerApi(grain) : { outcome: 'owner-api', method: 'PUT', path: '/v1/works/{work}/realizations/{realization}' };
    },
    async create(_input, _receipt, _actor, _type, parentComposition = null) {
      calls.push(parentComposition ? `create:${parentComposition}` : 'create');
      return script.create ? script.create(parentComposition) : { outcome: 'created', work: createdWork };
    },
    async provenance() { calls.push('provenance'); return script.provenance ? script.provenance() : marked; },
  };
}
