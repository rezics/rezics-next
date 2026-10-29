import { describe, expect, test } from 'bun:test';
import {
  parseCapabilityManifest,
  validateCapabilityManifest,
  validateScenarioReport,
  SURFACES,
} from './capabilities.ts';

function fixture(scope = 'Catalogue') {
  const columns = ['Scope row', 'User job', 'Personas', 'Fixture data', ...SURFACES, 'Native acceptance command'];
  const row = [
    scope,
    'Browse a catalogue',
    'reader and editor',
    'released fixture',
    ...SURFACES.map((surface) =>
      surface === 'catalogue'
        ? 'scenario:catalogue reads released data'
        : 'reason:This capability does not appear here',
    ),
    '["bun","test","native.test.ts"]',
  ];
  return `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${row.join(' | ')} |`;
}

describe('capability completion contract', () => {
  test("manager completion is refused while the Goal's capability manifest misses an In row of docs/scope.md, leaves a surface cell without a scenario or reason, or names a scenario whose registered native command did not pass at the candidate revision", () => {
    const scope = '| System | Owner | First public scope |\n| --- | --- | --- |\n| Catalogue | semantic | In |';
    const complete = parseCapabilityManifest(fixture(), 'semantic');
    expect(validateCapabilityManifest(complete, scope)).toEqual([]);
    expect(validateCapabilityManifest(parseCapabilityManifest(fixture('Other'), 'semantic'), scope)).toContain(
      'Missing In scope row: Catalogue',
    );
    expect(
      validateCapabilityManifest(
        parseCapabilityManifest(fixture().replace('reason:This capability does not appear here', ''), 'semantic'),
        scope,
      ).some((error) => error.includes('curated needs scenario names or a reason')),
    ).toBe(true);
    expect(
      validateScenarioReport(
        '<testsuite><testcase name="other scenario"/></testsuite>',
        complete.capabilities[0]!.scenarios,
      ),
    ).toContain('Scenario did not execute exactly: catalogue reads released data');
  });

  test("promotion runs each changed Goal's registered capability commands once per revision and requires exact scenario execution with zero skips or todos", () => {
    const manifest = parseCapabilityManifest(fixture(), 'semantic');
    const scenarios = manifest.capabilities[0]!.scenarios;
    const passed = '<testsuite><testcase name="catalogue reads released data"/></testsuite>';
    expect(validateScenarioReport(passed, scenarios)).toEqual([]);
    expect(
      validateScenarioReport(
        '<testsuite><testcase name="catalogue reads released data"><skipped/></testcase></testsuite>',
        scenarios,
      ),
    ).toContain('Scenario was skipped or todo: catalogue reads released data');
    expect(
      validateScenarioReport(
        '<testsuite><testcase name="catalogue reads released data"><failure/></testcase></testsuite>',
        scenarios,
      ),
    ).toContain('Scenario failed: catalogue reads released data');
  });

  test('scope rows with multiple owners and reasons without an explanation are validated', () => {
    const scope = '| System | Owner | First public scope |\n| --- | --- | --- |\n| Notifications | content; accounts for preferences | In |';
    const manifest = parseCapabilityManifest(fixture('Notifications'), 'accounts');
    expect(validateCapabilityManifest(manifest, scope)).toEqual([]);
    const emptyReason = parseCapabilityManifest(
      fixture('Notifications').replace('reason:This capability does not appear here', 'reason:'),
      'accounts',
    );
    expect(validateCapabilityManifest(emptyReason, scope)).toContain(
      'Notifications curated needs scenario names or a reason',
    );
  });
});
