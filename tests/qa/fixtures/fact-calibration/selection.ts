import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fixed selection seed. Changing it selects a different subset. */
export const SEED = 'g-116-fact-calibration-v1';
export const PER_STRATUM = 16;
/** Skip a lower-ranked claim when its token Jaccard overlap with a kept claim is at least this. */
export const SIMILARITY_CUTOFF = 0.5;
export const LABELS = ['SUPPORTS', 'REFUTES', 'NOT ENOUGH INFO'] as const;
export const DOMAINS = [
  'screen',
  'music',
  'sport',
  'literature',
  'place',
  'public-affairs',
  'science',
  'other',
] as const;

export type Label = (typeof LABELS)[number];
export type Domain = (typeof DOMAINS)[number];

/** Official shared-task development file, hashed locally on 2026-09-27. */
export const SOURCE = {
  name: 'FEVER',
  version: 'shared-task labelled development set',
  page: 'https://fever.ai/dataset/fever.html',
  url: 'https://fever.ai/download/fever/shared_task_dev.jsonl',
  licencePage: 'https://fever.ai/download/fever/license.html',
  licence: 'CC BY-SA 3.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
  bytes: 4_349_935,
  lines: 19_998,
  sha256: 'e89865bfe1b4dd054e03dd57d7241a6fde24862905f31117cf0cd719f7c78df7',
} as const;

export type SourceClaim = {
  id: number;
  label: string;
  claim: string;
  evidence?: unknown;
};

export type CalibrationClaim = {
  id: number;
  label: Label;
  domain: Domain;
  claim: string;
  evidence: [string, number][];
};

export type StratumCount = { label: Label; domain: Domain; selected: number; pool: number };

type Rule = readonly [Domain, RegExp];

// Parenthetical disambiguators are tested left to right, then keyword rules in order.
// The first match wins. Claims that match nothing are `other`.
const PAREN_RULES: readonly Rule[] = [
  [
    'screen',
    /\b(?:film|tv series|tv serial|tv channel|season|episode|sitcom|miniseries|musical|actor|actress)\b/,
  ],
  ['music', /\b(?:album|song|singer|band|soundtrack|single)\b/],
  ['literature', /\b(?:novel|poem|play|book|writer|author)\b/],
  ['sport', /\b(?:footballer|cricketer|athlete|tournament)\b/],
  ['public-affairs', /\b(?:politician|president|minister|monarch|emperor|proconsul)\b/],
  ['place', /\b(?:city|country|island|river|state|province)\b/],
  ['science', /\b(?:species|genus|element|disease|protein)\b/],
];

const KEYWORD_RULES: readonly Rule[] = [
  [
    'screen',
    /\b(?:films?|movies?|television|tv series|sitcoms?|actors?|actresses?|directors?|directed|episodes?|cinema|documentaries|documentary|starred|starring|portrays|premiered|premieres?|miniseries|screenwriters?|box office)\b/,
  ],
  [
    'music',
    /\b(?:albums?|songs?|singers?|rappers?|soundtracks?|musicians?|concerts?|mixtapes?|guitarists?|bands?|music)\b/,
  ],
  [
    'sport',
    /\b(?:football|soccer|basketball|baseball|cricket|tennis|olympics?|championships?|fifa|nba|nfl|nhl|mlb|quarterbacks?|world cup|athletes?|golf|formula one|grand prix|tour de france)\b/,
  ],
  [
    'literature',
    /\b(?:novels?|poems?|poets?|authors?|novelists?|playwrights?|writers?|comic books?|memoirs?|biograph(?:y|ies)|books?)\b/,
  ],
  [
    'public-affairs',
    /\b(?:presidents?|prime ministers?|ministers?|elections?|parliaments?|senators?|politicians?|governments?|congress|governors?|mayors?|politics|senates?|genocides?|revolutions?|treaties|dynasties|dynasty|colonial|(?<!united )kingdoms?)\b|\bbattle of\b|\b(?:civil|world) wars?\b/,
  ],
  [
    'place',
    /\b(?:capitals?|cities|city|countries|country|rivers?|provinces?|counties|population|metropolitan|mountains?|located)\b/,
  ],
  [
    'science',
    /\b(?:species|planets?(?! hollywood)|diseases?|physics|biology|proteins?|molecules?|genomes?|viruses?|physicians?|genus|bacteria|fossils?|astronomy|astronomical|uranium|hypothalamus|chromosomes?|enzymes?|vaccines?|antibiotics?)\b/,
  ],
];

const PAREN = /[(]([^)]{1,80})[)]/g;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lexicographic SHA-256 hex of `seed`, a newline and the decimal id. */
export function rankOf(seed: string, id: number): string {
  return sha256Hex(`${seed}\n${id}`);
}

export function stratumKey(label: Label, domain: Domain): string {
  return `${label}|${domain}`;
}

function tokensOf(claim: string): Set<string> {
  return new Set(claim.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

export function domainOf(claim: string): Domain {
  const lower = claim.toLowerCase();
  for (const match of lower.matchAll(PAREN)) {
    const inner = match[1] ?? '';
    for (const [domain, pattern] of PAREN_RULES) {
      if (pattern.test(inner)) return domain;
    }
  }
  for (const [domain, pattern] of KEYWORD_RULES) {
    if (pattern.test(lower)) return domain;
  }
  return 'other';
}

/** FEVER evidence is a list of [annotation id, evidence id, page, sentence] tuples. */
export function evidencePointers(evidence: unknown): [string, number][] {
  if (!Array.isArray(evidence)) return [];
  const seen = new Set<string>();
  const pointers: [string, number][] = [];
  for (const group of evidence) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!Array.isArray(item) || item.length < 4) continue;
      const page = item[2];
      const sentence = item[3];
      if (typeof page !== 'string' || page.length === 0) continue;
      if (typeof sentence !== 'number' || !Number.isInteger(sentence) || sentence < 0) continue;
      const key = `${page}\n${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pointers.push([page, sentence]);
    }
  }
  return pointers;
}

function usable(record: SourceClaim): boolean {
  return (
    Number.isSafeInteger(record.id) &&
    record.id >= 0 &&
    typeof record.claim === 'string' &&
    record.claim.length > 0 &&
    isLabel(record.label)
  );
}

export function select(
  records: readonly SourceClaim[],
  seed: string,
  perStratum: number,
): {
  selected: CalibrationClaim[];
  strata: StratumCount[];
} {
  const groups = new Map<string, SourceClaim[]>();
  for (const domain of DOMAINS) {
    for (const label of LABELS) groups.set(stratumKey(label, domain), []);
  }
  for (const record of records) {
    if (!usable(record)) continue;
    groups.get(stratumKey(record.label, domainOf(record.claim)))!.push(record);
  }
  const selected: CalibrationClaim[] = [];
  const strata: StratumCount[] = [];
  for (const domain of DOMAINS) {
    for (const label of LABELS) {
      const group = groups.get(stratumKey(label, domain))!;
      const ranked = [...group].sort((left, right) => {
        const rank = rankOf(seed, left.id).localeCompare(rankOf(seed, right.id));
        return rank !== 0 ? rank : left.id - right.id;
      });
      const taken: SourceClaim[] = [];
      const keptTokens: Set<string>[] = [];
      for (const record of ranked) {
        if (taken.length >= perStratum) break;
        const tokens = tokensOf(record.claim);
        if (keptTokens.some((prior) => jaccard(tokens, prior) >= SIMILARITY_CUTOFF)) continue;
        taken.push(record);
        keptTokens.push(tokens);
      }
      strata.push({ label, domain, selected: taken.length, pool: group.length });
      for (const record of taken) {
        selected.push({
          id: record.id,
          label,
          domain,
          claim: record.claim,
          evidence: evidencePointers(record.evidence),
        });
      }
    }
  }
  return { selected, strata };
}

export function serializeClaim(row: CalibrationClaim): string {
  return JSON.stringify({
    id: row.id,
    label: row.label,
    domain: row.domain,
    claim: row.claim,
    evidence: row.evidence,
  });
}

export function serializeSubset(rows: readonly CalibrationClaim[]): string {
  return rows.map(serializeClaim).join('\n') + '\n';
}

function parseSource(bytes: Buffer): SourceClaim[] {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('FEVER source must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== SOURCE.lines)
    throw new Error(`expected ${SOURCE.lines} lines, found ${lines.length}`);
  const seen = new Set<number>();
  return lines.map((line, index) => {
    const value = JSON.parse(line) as SourceClaim;
    if (!Number.isSafeInteger(value.id) || seen.has(value.id)) {
      throw new Error(`duplicate or invalid id at line ${index + 1}`);
    }
    seen.add(value.id);
    return value;
  });
}

function build(sourcePath: string): void {
  const bytes = readFileSync(sourcePath);
  const digest = sha256Hex(bytes);
  if (bytes.length !== SOURCE.bytes || digest !== SOURCE.sha256) {
    throw new Error(`source checksum mismatch: ${bytes.length} bytes ${digest}`);
  }
  const { selected, strata } = select(parseSource(bytes), SEED, PER_STRATUM);
  const short = strata.filter((row) => row.pool < PER_STRATUM);
  if (short.length) {
    throw new Error(
      `stratum pool below ${PER_STRATUM}: ${short
        .map((row) => `${row.label}|${row.domain}=${row.pool}`)
        .join(', ')}`,
    );
  }
  const body = serializeSubset(selected);
  const directory = dirname(fileURLToPath(import.meta.url));
  writeFileSync(resolve(directory, 'claims.jsonl'), body);
  const manifest = {
    name: 'fact-calibration-v1',
    seed: SEED,
    perStratum: PER_STRATUM,
    method: 'stratified-sha256-rank+jaccard-0.5',
    retrieved: '2026-09-27',
    source: SOURCE,
    citation: {
      authors: 'James Thorne, Andreas Vlachos, Christos Christodoulopoulos, and Arpit Mittal',
      title: 'FEVER: a Large-scale Dataset for Fact Extraction and VERification',
      venue: 'NAACL-HLT 2018',
      url: 'https://aclanthology.org/N18-1074/',
      doi: '10.18653/v1/N18-1074',
    },
    subset: {
      file: 'claims.jsonl',
      sha256: sha256Hex(body),
      count: selected.length,
      strata,
    },
  };
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${selected.length} claims`);
  for (const row of strata)
    console.log(`${row.label}\t${row.domain}\t${row.selected}\t${row.pool}`);
}

if (import.meta.main) build(process.argv[2] ?? '');
