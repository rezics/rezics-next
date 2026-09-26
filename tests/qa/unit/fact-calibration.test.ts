import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CalibrationClaim,
  DOMAINS,
  domainOf,
  evidencePointers,
  LABELS,
  type Label,
  PER_STRATUM,
  rankOf,
  SEED,
  SOURCE,
  type SourceClaim,
  type StratumCount,
  select,
  serializeSubset,
  sha256Hex,
} from '../fixtures/fact-calibration/selection.ts';

const claimsPath = resolve('tests/qa/fixtures/fact-calibration/claims.jsonl');
const manifestPath = resolve('tests/qa/fixtures/fact-calibration/manifest.json');
const pinnedRank = '0916ee7ad5002276461a9717c136cb1c33299d7518d40ff82b8f54f7e860366b';

type Manifest = {
  seed: string;
  perStratum: number;
  method: string;
  source: typeof SOURCE;
  subset: { file: string; sha256: string; count: number; strata: StratumCount[] };
};

function load(): { manifest: Manifest; text: string; rows: CalibrationClaim[] } {
  const text = readFileSync(claimsPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  expect(text.endsWith('\n')).toBe(true);
  const lines = text.slice(0, -1).split('\n');
  expect(lines.some((line) => line.length === 0)).toBe(false);
  return { manifest, text, rows: lines.map((line) => JSON.parse(line) as CalibrationClaim) };
}

test('fact-calibration: subset matches its manifest checksum, seed and stratum counts', () => {
  const { manifest, text, rows } = load();
  expect(manifest.seed).toBe(SEED);
  expect(manifest.perStratum).toBe(PER_STRATUM);
  expect(manifest.method).toBe('stratified-sha256-rank+jaccard-0.5');
  expect(manifest.source).toEqual(SOURCE);
  expect(manifest.subset.file).toBe('claims.jsonl');
  expect(sha256Hex(text)).toBe(manifest.subset.sha256);
  expect(rows).toHaveLength(LABELS.length * DOMAINS.length * PER_STRATUM);
  expect(manifest.subset.count).toBe(rows.length);
  expect(serializeSubset(rows)).toBe(text);
  expect(rankOf(SEED, 1)).toBe(pinnedRank);

  const counts = new Map<string, number>();
  const ids = new Set<number>();
  for (const row of rows) {
    expect(LABELS).toContain(row.label);
    expect(DOMAINS).toContain(row.domain);
    expect(domainOf(row.claim)).toBe(row.domain);
    expect(Number.isSafeInteger(row.id)).toBe(true);
    expect(ids.has(row.id)).toBe(false);
    ids.add(row.id);
    expect(
      row.evidence.every(
        ([page, sentence]) =>
          typeof page === 'string' &&
          page.length > 0 &&
          Number.isInteger(sentence) &&
          sentence >= 0,
      ),
    ).toBe(true);
    const key = `${row.label}|${row.domain}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  expect(manifest.subset.strata).toHaveLength(DOMAINS.length * LABELS.length);
  let pool = 0;
  manifest.subset.strata.forEach((stratum, index) => {
    const domain = DOMAINS[Math.floor(index / LABELS.length)];
    const label = LABELS[index % LABELS.length];
    expect(stratum).toEqual({ label, domain, selected: PER_STRATUM, pool: stratum.pool });
    expect(stratum.pool).toBeGreaterThanOrEqual(PER_STRATUM);
    pool += stratum.pool;
    expect(counts.get(`${label}|${domain}`)).toBe(PER_STRATUM);
  });
  expect(pool).toBe(SOURCE.lines);

  const ordered = [...rows].sort((left, right) => {
    const domain = DOMAINS.indexOf(left.domain) - DOMAINS.indexOf(right.domain);
    if (domain !== 0) return domain;
    const label = LABELS.indexOf(left.label) - LABELS.indexOf(right.label);
    if (label !== 0) return label;
    const rank = rankOf(SEED, left.id).localeCompare(rankOf(SEED, right.id));
    return rank !== 0 ? rank : left.id - right.id;
  });
  expect(rows.map((row) => row.id)).toEqual(ordered.map((row) => row.id));

  const supportsScreen = rows.filter((row) => row.label === 'SUPPORTS' && row.domain === 'screen');
  const winner = (seed: string) =>
    supportsScreen.reduce((best, row) =>
      rankOf(seed, row.id) < rankOf(seed, best.id) ? row : best,
    ).id;
  expect(winner(SEED)).toBe(supportsScreen[0]?.id);
  expect(
    ['fact-calibration-v2', 'other-seed', 'seed-b'].some((seed) => winner(seed) !== winner(SEED)),
  ).toBe(true);
});

test('fact-calibration: selection is deterministic, stratified and skips near-copies', () => {
  const film = (topic: string, animal: string, marker: string) =>
    `${topic} ${animal} ${marker} film.`;
  const topics = [
    ['alphaquoll', 'zebras', 'kestrel'],
    ['bravomantis', 'yachts', 'pelican'],
    ['charlieibis', 'quilts', 'violet'],
    ['deltaviper', 'noodles', 'jasper'],
    ['echolichen', 'pistons', 'cobalt'],
  ] as const;
  const records: SourceClaim[] = [];
  const nearCopyIds: number[] = [];
  let id = 1;
  for (const label of LABELS) {
    for (const [topic, animal, marker] of topics) {
      records.push({
        id: id++,
        label,
        claim: film(topic, animal, marker),
        evidence: [[['annotation', 'evidence', `${topic}_Page`, 0]]],
      });
    }
    nearCopyIds.push(id);
    records.push({
      id: id++,
      label,
      claim: `${film('alphaquoll', 'zebras', 'kestrel')} quartz repeated similar wording.`,
      evidence: [[['annotation', 'evidence', null, null]]],
    });
  }
  records.push({ id: -1, label: 'SUPPORTS', claim: 'A film about nothing useful.', evidence: [] });
  records.push({
    id: 9_000,
    label: 'UNKNOWN',
    claim: 'A film about an unknown label.',
    evidence: [],
  });

  const first = select(records, SEED, topics.length);
  expect(select(records, SEED, topics.length)).toEqual(first);
  expect(first.selected).toHaveLength(LABELS.length * topics.length);
  expect(first.selected.every((row) => row.domain === 'screen')).toBe(true);
  for (const [labelIndex, label] of LABELS.entries()) {
    const chosen = first.selected.filter((row) => row.label === label).map((row) => row.id);
    expect(chosen).toHaveLength(topics.length);
    const nearCopy = nearCopyIds[labelIndex]!;
    expect(
      [nearCopy - topics.length, nearCopy].filter((item) => chosen.includes(item)),
    ).toHaveLength(1);
    expect(
      first.strata.find((row) => row.label === label && row.domain === 'screen'),
    ).toMatchObject({
      selected: topics.length,
      pool: topics.length + 1,
    });
  }
  expect(
    select(records, 'fact-calibration-v2', topics.length).selected.map((row) => row.id),
  ).not.toEqual(first.selected.map((row) => row.id));
  expect(domainOf('Planet Hollywood Las Vegas is operated by someone.')).toBe('other');
  expect(domainOf('Sky UK is a company which serves the United Kingdom.')).toBe('other');
  expect(domainOf('Warcraft premiered in Paris before the Rio Olympics.')).toBe('screen');
  expect(domainOf('GLOW (TV series) ended.')).toBe('screen');
  expect(domainOf('Rabies is a disease.')).toBe('science');
  expect(domainOf('The Battle of France happened during World War II.')).toBe('public-affairs');
  expect(
    evidencePointers([
      [
        ['annotation', 'evidence', 'Oliver_Reed', 0],
        ['annotation', 'evidence', null, null],
        ['annotation', 'evidence', 'Oliver_Reed', 0],
      ],
    ]),
  ).toEqual([['Oliver_Reed', 0]]);
});

test('fact-calibration: claim-text domains stay on the declared rules', () => {
  const cases: Array<[string, CalibrationClaim['domain']]> = [
    ['Vedam is a drama film.', 'screen'],
    ['Ice-T began his career as a rapper in the 1980s.', 'music'],
    ["The 2003 NCAA Division I Men's Basketball Tournament was played.", 'sport'],
    ['The Hunger Games is only a novel.', 'literature'],
    ['Vatican City was established in 1929.', 'place'],
    ['Ann Richards was the Governor of Texas for one year.', 'public-affairs'],
    ["Parkinson's disease prevents tremors.", 'science'],
    ['William Blackstone went to Pembroke College in Oxford.', 'other'],
  ];
  for (const [claim, domain] of cases) expect(domainOf(claim)).toBe(domain);
  const labels: Label[] = [...LABELS];
  expect(labels).toHaveLength(3);
});
