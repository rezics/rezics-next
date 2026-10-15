import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeReplayFixtures, root, evidenceDirectory } from './command-replay-authorization/fixtures.ts';
import { registerReplayCases, registerNonReplayCases, replayCaseNames } from './command-replay-authorization/driver.ts';
import { authorityLosses } from './command-replay-authorization/authority-classes.ts';
import { commandCoverage, discoverPublicCommands, type ReplayArea } from './command-replay-authorization/public-callers.ts';
import { uncoveredReasons } from './command-replay-authorization/uncovered-reasons.ts';
import { coveredBaseline } from './command-replay-authorization/covered-baseline.ts';
import * as access from './command-replay-authorization/access.entries.ts';
import * as identity from './command-replay-authorization/identity.entries.ts';
import * as governance from './command-replay-authorization/governance.entries.ts';
import * as source from './command-replay-authorization/source.entries.ts';
import * as editorial from './command-replay-authorization/editorial.entries.ts';
import * as meaning from './command-replay-authorization/meaning.entries.ts';
import * as structure from './command-replay-authorization/structure.entries.ts';
import * as realms from './command-replay-authorization/realms.entries.ts';
import * as reading from './command-replay-authorization/reading.entries.ts';
import * as media from './command-replay-authorization/media.entries.ts';

const areas: ReplayArea[] = [access, identity, governance, source, editorial, meaning, structure, realms, reading, media];
const replayEntries = areas.flatMap(area => area.replayEntries);
initializeReplayFixtures();
registerReplayCases(replayEntries);
registerNonReplayCases(areas.flatMap(area => area.nonReplayEntries ?? []));

test('public saved-result coverage ratchet preserves executed cases and names every remaining command', () => {
  // The cut's executed baseline is immutable; area entries can only extend it.
  expect(createHash('sha256').update(JSON.stringify(coveredBaseline)).digest('hex'))
    .toBe('d9a5d511a9ef756958620408ca46944da207c9f4bb4dba13a3e026420da31bb4');
  const coverage = commandCoverage(discoverPublicCommands(root), areas, 117);
  const { inventory } = coverage;
  writeFileSync(join(evidenceDirectory, 'public-command-inventory.json'), JSON.stringify(inventory, null, 2));
  expect(Object.keys(uncoveredReasons).sort()).toEqual([...coverage.uncovered].sort());
  const gaps = coverage.uncovered.map(operation => ({ ...inventory.find(command => command.operation === operation),
    operation, reason: uncoveredReasons[operation] }));
  for (const gap of gaps) expect(gap.reason!.trim().length).toBeGreaterThan(0);
  writeFileSync(join(evidenceDirectory, 'public-command-coverage.json'), JSON.stringify({ ...coverage, gaps }, null, 2));
  expect(inventory.length).toBeGreaterThan(0);
  const covered = areas.flatMap(area => area.coveredOperations);
  const uncovered = areas.flatMap(area => area.uncoveredOperations);
  expect(new Set(covered).size).toBe(covered.length);
  expect(new Set(uncovered).size).toBe(uncovered.length);
  expect(covered.filter(operation => uncovered.includes(operation))).toEqual([]);
  for (const operation of coveredBaseline.operations) expect(covered).toContain(operation);
  const cases = replayEntries.flatMap(entry => entry.subcases.flatMap(subcase =>
    authorityLosses(entry).flatMap(loss => replayCaseNames(entry, subcase, loss))));
  expect(new Set(cases).size).toBe(cases.length);
  for (const witness of coveredBaseline.cases) expect(cases).toContain(witness);
  expect(inventory.filter(command => !covered.includes(command.operation) && !uncovered.includes(command.operation))
    .map(command => ({ operation: command.operation, caller: command.caller, paths: command.paths }))).toEqual([]);
  for (const entry of replayEntries) {
    expect(entry.subcases.length).toBeGreaterThan(0);
    expect(entry.losses?.length ?? 2).toBeGreaterThan(0);
    expect(entry.scope.length).toBeGreaterThan(0);
    expect(entry.action.length).toBeGreaterThan(0);
  }
  for (const command of inventory.filter(command => covered.includes(command.operation))) {
    const owners = replayEntries.filter(entry => entry.operation === command.operation).flatMap(entry => entry.owners);
    expect(command.paths.filter(path => !path.some(owner => owners.includes(owner)))).toEqual([]);
  }
  // Uncovered entries are real public caller traces, not an escape list.
  expect(uncovered.filter(operation => !inventory.some(command => command.operation === operation))).toEqual([]);
  for (const area of areas) for (const operation of area.uncoveredOperations) {
    const command = inventory.find(command => command.operation === operation)!;
    const firstOwner = command.paths[0]!.find(owner => owner.startsWith('modules/'))!.split('/')[1]!;
    expect(area.moduleOwners).toContain(firstOwner);
  }
}, 120_000);
