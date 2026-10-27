#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import {
  calibrateUncertainty,
  detectableSlope,
  type CalibratedUncertainty,
} from '../test/support/growth-calibration.ts';
import {
  GROWTH_PROFILE_METRICS,
  growthProfileCheckId,
  medianGrowthValue,
  readGrowthProfiles,
  type GrowthProfileEntry,
  type GrowthProfileMetric,
  type GrowthProfileRead,
  type GrowthProfileRunSource,
} from '../test/support/growth-profile-read.ts';
import { classifySeries } from '../test/support/growth-model.ts';

const COVERAGES = [1, 0.99] as const;
const SCALE_SETS = [
  [1, 8, 64],
  [1, 4, 16, 64, 256],
] as const;
const METRIC_UNITS: Readonly<Record<GrowthProfileMetric, string>> = {
  rows: 'rows visited',
  blocks: 'buffer blocks touched',
  statements: 'SQL statements',
};

type CalibrationByCoverage = Readonly<Record<(typeof COVERAGES)[number], CalibratedUncertainty>>;

type WorstPoint = Readonly<{
  metric: GrowthProfileMetric;
  file: string;
  check: string;
  occurrence: number;
  run: string;
  scale: number;
  reference: number;
  need: number;
  allowance: number;
  ratio: number;
  suggestion: string;
}>;

type ReclassifiedCheck = Readonly<{
  coverage: number;
  metric: GrowthProfileMetric;
  file: string;
  check: string;
  occurrence: number;
  owner: string;
  run: string;
  outcome: string;
}>;

function formatNumber(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return '∞';
  if (Object.is(value, -0)) return '0';
  if (value === 0) return '0';
  return Number(value.toPrecision(5)).toString();
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100)}%`;
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function mapCalibrations(read: GrowthProfileRead): Map<GrowthProfileMetric, CalibrationByCoverage> {
  const result = new Map<GrowthProfileMetric, CalibrationByCoverage>();
  for (const metric of GROWTH_PROFILE_METRICS) {
    const series = read.series[metric];
    if (series.length === 0) throw new Error(`No complete unchanged-code checks are available for ${metric}`);
    const byCoverage = {} as Record<(typeof COVERAGES)[number], CalibratedUncertainty>;
    for (const coverage of COVERAGES) byCoverage[coverage] = calibrateUncertainty(series, { coverage });
    result.set(metric, byCoverage);
  }
  return result;
}

function calibrationFor(
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
  metric: GrowthProfileMetric,
  coverage: number,
): CalibratedUncertainty {
  const found = calibrations.get(metric)?.[coverage as (typeof COVERAGES)[number]];
  if (!found) throw new Error(`Missing ${metric} calibration for coverage ${coverage}`);
  return found;
}

function eligibleEntries(read: GrowthProfileRead, metric: GrowthProfileMetric): GrowthProfileEntry[] {
  const ids = new Set(read.series[metric].map(({ check }) => check));
  return read.entries.filter(({ file, check, occurrence }) => ids.has(growthProfileCheckId(file, check, occurrence)));
}

function ownerModule(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const testIndex = normalized.lastIndexOf('/test/');
  const testPath = testIndex >= 0 ? normalized.slice(testIndex + '/test/'.length) : normalized.replace(/^test\//, '');
  const directory = posix.dirname(testPath);
  return directory === '.' ? 'kernel' : directory;
}

function checkLabel(check: string, occurrence: number): string {
  return occurrence === 1 ? check : `${check} [occurrence ${occurrence}]`;
}

function reclassifiedChecks(
  entries: readonly GrowthProfileEntry[],
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
): ReclassifiedCheck[] {
  const issues: ReclassifiedCheck[] = [];
  for (const metric of GROWTH_PROFILE_METRICS) {
    for (const coverage of COVERAGES) {
      const uncertainty = calibrationFor(calibrations, metric, coverage);
      for (const entry of entries) {
        const outcome = classifySeries(
          entry.scales.map((scale, index) => {
            const repetitions = entry.repetitions[index]!.map((repetition) => repetition[metric]);
            const median = medianGrowthValue(repetitions);
            return {
              scale,
              repetitions,
              uncertainty: Math.max(uncertainty.absolute, uncertainty.relative * median),
            };
          }),
          entry.bounds[metric],
        ).outcome;
        if (outcome !== 'compatible')
          issues.push({
            coverage,
            metric,
            file: entry.file,
            check: checkLabel(entry.check, entry.occurrence),
            occurrence: entry.occurrence,
            owner: ownerModule(entry.file),
            run: entry.run,
            outcome,
          });
      }
    }
  }
  return issues;
}

function suggestion(repetitionHalfSpread: number, runMedianDeviation: number): string {
  if (repetitionHalfSpread > runMedianDeviation && repetitionHalfSpread > 0)
    return 'Within-run spread points to load or transient state noise.';
  if (runMedianDeviation > 0 && repetitionHalfSpread === runMedianDeviation)
    return 'Within-run load and between-run state or plan shifts contribute equally.';
  if (runMedianDeviation > 0)
    return 'Between-run shift points to database state or plan drift; inspect the relation sizes and query plan.';
  return 'No measurable state, plan, or load variation at this point.';
}

function worstPoints(
  read: GrowthProfileRead,
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
): WorstPoint[] {
  const points: WorstPoint[] = [];
  for (const metric of GROWTH_PROFILE_METRICS) {
    const groups = read.series[metric];
    const entries = eligibleEntries(read, metric);
    const byCheck = new Map<string, GrowthProfileEntry[]>();
    for (const entry of entries) {
      const id = growthProfileCheckId(entry.file, entry.check, entry.occurrence);
      const group = byCheck.get(id) ?? [];
      group.push(entry);
      byCheck.set(id, group);
    }
    const uncertainty = calibrationFor(calibrations, metric, 1);
    for (const group of groups) {
      const checkEntries = byCheck.get(group.check)!;
      for (let scaleIndex = 0; scaleIndex < checkEntries[0]!.scales.length; scaleIndex += 1) {
        const runValues = checkEntries.map((entry) => {
          const values = entry.repetitions[scaleIndex]!.map((repetition) => repetition[metric]);
          return { entry, values, median: medianGrowthValue(values) };
        });
        const reference = medianGrowthValue(runValues.map(({ median }) => median));
        for (const { entry, values, median } of runValues) {
          const repetitionHalfSpread = (Math.max(...values) - Math.min(...values)) / 2;
          const runMedianDeviation = Math.abs(median - reference);
          const need = Math.max(runMedianDeviation, repetitionHalfSpread);
          const allowance = Math.max(uncertainty.absolute, uncertainty.relative * reference);
          const ratio = allowance === 0 ? (need === 0 ? 0 : Number.POSITIVE_INFINITY) : need / allowance;
          points.push({
            metric,
            file: entry.file,
            check: entry.check,
            occurrence: entry.occurrence,
            run: entry.run,
            scale: entry.scales[scaleIndex]!,
            reference,
            need,
            allowance,
            ratio,
            suggestion: suggestion(repetitionHalfSpread, runMedianDeviation),
          });
        }
      }
    }
  }
  return points
    .toSorted(
      (left, right) =>
        right.ratio - left.ratio ||
        right.need - left.need ||
        left.metric.localeCompare(right.metric) ||
        left.file.localeCompare(right.file) ||
        left.check.localeCompare(right.check) ||
        left.run.localeCompare(right.run) ||
        left.scale - right.scale,
    )
    .slice(0, 5);
}

function heldOutTable(calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>): string[] {
  const rows = [
    '| Metric | Requested coverage | Absolute E | Relative E | Exact | Held-out coverage |',
    '| --- | ---: | ---: | ---: | :---: | ---: |',
  ];
  for (const metric of GROWTH_PROFILE_METRICS) {
    for (const coverage of COVERAGES) {
      const value = calibrationFor(calibrations, metric, coverage);
      rows.push(
        `| ${metric} | ${formatPercent(coverage)} | ${formatNumber(value.absolute)} | ${formatPercent(value.relative)} | ${value.exact ? 'yes' : 'no'} | ${formatPercent(value.heldOutCoverage)} |`,
      );
    }
  }
  return rows;
}

function detectableSlopeTable(
  read: GrowthProfileRead,
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
): string[] {
  const rows = [
    '| Metric | Coverage | Bound | Scales | Base | Detectable slope | Smallest extra work or scan detectable |',
    '| --- | ---: | --- | --- | ---: | ---: | --- |',
  ];
  for (const metric of GROWTH_PROFILE_METRICS) {
    const entries = eligibleEntries(read, metric);
    const base = medianGrowthValue(
      entries.map((entry) => medianGrowthValue(entry.repetitions[0]!.map((item) => item[metric]))),
    );
    for (const coverage of COVERAGES) {
      const uncertainty = calibrationFor(calibrations, metric, coverage);
      for (const bound of ['constant', 'logarithmic'] as const) {
        for (const scales of SCALE_SETS) {
          const slope = detectableSlope(scales, uncertainty, bound, base);
          const effect =
            slope === Number.POSITIVE_INFINITY
              ? `No finite additional ${METRIC_UNITS[metric]} per input row is rejected in this range.`
              : `About ${formatNumber(slope)} extra ${METRIC_UNITS[metric]} per input row (base ${formatNumber(base)}).`;
          rows.push(
            `| ${metric} | ${formatPercent(coverage)} | ${bound} | ${scales.join(', ')} | ${formatNumber(base)} | ${formatNumber(slope)} | ${effect} |`,
          );
        }
      }
    }
  }
  return rows;
}

function reclassifiedTable(
  entries: readonly GrowthProfileEntry[],
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
): string[] {
  const issues = reclassifiedChecks(entries, calibrations);
  const grouped = new Map<string, ReclassifiedCheck[]>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.coverage, issue.metric, issue.file, issue.check, issue.owner, issue.outcome]);
    const group = grouped.get(key) ?? [];
    group.push(issue);
    grouped.set(key, group);
  }
  const rows = [
    '| Coverage | Metric | File | Check | Owner module | Outcome | Runs |',
    '| ---: | --- | --- | --- | --- | --- | --- |',
  ];
  if (issues.length === 0) rows.push('| — | — | — | No checks | — | — | — |');
  else {
    for (const group of grouped.values()) {
      const issue = group[0]!;
      rows.push(
        `| ${formatPercent(issue.coverage)} | ${issue.metric} | ${markdownCell(issue.file)} | ${markdownCell(issue.check)} | ${markdownCell(issue.owner)} | ${issue.outcome} | ${group.map(({ run }) => markdownCell(run)).join(', ')} |`,
      );
    }
  }
  return rows;
}

function relationTable(relations: GrowthProfileRead['nonGrowingRelations']): string[] {
  const grouped = new Map<
    string,
    { file: string; check: string; run: string; relation: string; first: number; last: number }[]
  >();
  for (const relation of relations) {
    const key = JSON.stringify([relation.file, relation.check, relation.occurrence, relation.relation]);
    const group = grouped.get(key) ?? [];
    group.push(relation);
    grouped.set(key, group);
  }
  const rows = ['| File | Check | Relation | Run sizes (first → last reltuples) |', '| --- | --- | --- | --- |'];
  if (relations.length === 0) rows.push('| — | — | None | — |');
  else {
    for (const group of grouped.values()) {
      const relation = group[0]!;
      rows.push(
        `| ${markdownCell(relation.file)} | ${markdownCell(checkLabel(relation.check, relation.occurrence))} | ${markdownCell(relation.relation)} | ${group.map(({ run, first, last }) => `${markdownCell(run)}: ${formatNumber(first)} → ${formatNumber(last)}`).join('; ')} |`,
      );
    }
  }
  return rows;
}

function shadowTable(shadowOutcomes: GrowthProfileRead['shadowOutcomes']): string[] {
  const grouped = new Map<string, GrowthProfileRead['shadowOutcomes'][number][]>();
  for (const item of shadowOutcomes) {
    const key = JSON.stringify([item.file, item.check, item.occurrence]);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  const rows = ['| File | Check | Per-run shadow outcomes (rows / blocks / statements) |', '| --- | --- | --- |'];
  for (const group of grouped.values()) {
    const item = group[0]!;
    rows.push(
      `| ${markdownCell(item.file)} | ${markdownCell(checkLabel(item.check, item.occurrence))} | ${group.map(({ run, outcomes }) => `${markdownCell(run)}: ${outcomes.rows} / ${outcomes.blocks} / ${outcomes.statements}`).join('; ')} |`,
    );
  }
  return rows;
}

function worstPointsTable(
  read: GrowthProfileRead,
  calibrations: ReadonlyMap<GrowthProfileMetric, CalibrationByCoverage>,
): string[] {
  const rows = [
    '| Metric | File | Check | Run | Scale | Reference | Need | Allowance | Need / allowance | Suggestion |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const point of worstPoints(read, calibrations))
    rows.push(
      `| ${point.metric} | ${markdownCell(point.file)} | ${markdownCell(checkLabel(point.check, point.occurrence))} | ${markdownCell(point.run)} | ${formatNumber(point.scale)} | ${formatNumber(point.reference)} | ${formatNumber(point.need)} | ${formatNumber(point.allowance)} | ${formatNumber(point.ratio)} | ${markdownCell(point.suggestion)} |`,
    );
  return rows;
}

function omittedTable(read: GrowthProfileRead): string[] {
  const rows = ['| File | Check | Missing runs | Scales by run |', '| --- | --- | --- | --- |'];
  if (read.omitted.length === 0) rows.push('| — | — | None | — |');
  else {
    for (const item of read.omitted) {
      const scales = item.scalesByRun.map(({ run, scales: values }) => `${run}: ${values.join(', ')}`).join('; ');
      rows.push(
        `| ${markdownCell(item.file)} | ${markdownCell(checkLabel(item.check, item.occurrence))} | ${item.missingRuns.length ? item.missingRuns.map(markdownCell).join(', ') : '—'} | ${markdownCell(scales)} |`,
      );
    }
  }
  return rows;
}

function methodTable(
  calibrationSources: readonly GrowthProfileRunSource[],
  calibration: GrowthProfileRead,
  coverageSource: GrowthProfileRunSource,
  coverage: GrowthProfileRead,
): string[] {
  const profileFileCount = (read: GrowthProfileRead): number => new Set(read.entries.map(({ file }) => file)).size;
  return [
    '| Input | Runs | Files with profiles | Check profile lines |',
    '| --- | --- | ---: | ---: |',
    `| Calibration | ${calibrationSources.map(({ name }) => markdownCell(name)).join(', ')} | ${profileFileCount(calibration)} | ${calibration.entries.length} |`,
    `| Coverage | ${markdownCell(coverageSource.name)} | ${profileFileCount(coverage)} | ${coverage.entries.length} |`,
    '',
    '| Step | Rule |',
    '| --- | --- |',
    '| Reference | Per check and scale, median of the run medians. |',
    '| Noise need | max(absolute run-median deviation, half the within-run range). |',
    '| Fit | Search relative E from 0% to 100% in 1% steps; choose the least average max(absolute E, relative E × reference) covering the requested share of calibration points. |',
    '| Held-out | Leave out each check run, refit E, and measure covered points. |',
    '| Coverage run | Classify each coverage profile separately under both calibrated E values. |',
  ];
}

export function growthCalibrationReport(
  calibrationSources: readonly GrowthProfileRunSource[],
  coverageSource: GrowthProfileRunSource,
): string {
  const calibration = readGrowthProfiles(calibrationSources);
  const coverage = readGrowthProfiles([coverageSource]);
  if (calibration.entries.length === 0) throw new Error('No calibration profile lines were found in the input files');
  if (coverage.entries.length === 0) throw new Error(`No coverage profile lines were found in ${coverageSource.name}`);
  const calibrations = mapCalibrations(calibration);
  const relations = [...calibration.nonGrowingRelations, ...coverage.nonGrowingRelations];
  const shadowOutcomes = [...calibration.shadowOutcomes, ...coverage.shadowOutcomes];
  return [
    '# Growth uncertainty calibration',
    '',
    '## Method',
    '',
    ...methodTable(calibrationSources, calibration, coverageSource, coverage),
    '',
    '## Held-out coverage',
    '',
    ...heldOutTable(calibrations),
    '',
    '## Detectable slope',
    '',
    ...detectableSlopeTable(calibration, calibrations),
    '',
    '## Checks rejected or inconclusive under calibrated E',
    '',
    ...reclassifiedTable(coverage.entries, calibrations),
    '',
    '## Checks omitted from calibration',
    '',
    ...omittedTable(calibration),
    '',
    '## Relations whose size did not grow',
    '',
    ...relationTable(relations),
    '',
    '## Shadow outcomes by run',
    '',
    ...shadowTable(shadowOutcomes),
    '',
    '## Five worst calibration points',
    '',
    ...worstPointsTable(calibration, calibrations),
    '',
    '| Diagnostic | Interpretation |',
    '| --- | --- |',
    '| Need | Larger of run-median deviation from the across-run reference and half the within-run spread. |',
    '| Suggestion | Compares between-run and within-run variation; count profiles alone cannot separate database-state changes from plan changes. |',
    '',
  ].join('\n');
}

async function main(paths: readonly string[]): Promise<void> {
  if (paths.length < 3)
    throw new Error(
      'Usage: bun scripts/growth-calibrate.ts <calibration-run.jsonl> <calibration-run.jsonl>... <coverage-run.jsonl>',
    );
  const sources: GrowthProfileRunSource[] = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path, extname(path)),
      text: await readFile(path, 'utf8'),
    })),
  );
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new Error(`Profile input basenames must be unique: ${source.name}`);
    names.add(source.name);
  }
  process.stdout.write(growthCalibrationReport(sources.slice(0, -1), sources.at(-1)!));
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
