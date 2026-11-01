import { describe, expect, test } from 'bun:test';
import {
  aggregateRemoteGateReports,
  decodeGateReport,
  MAX_GATE_REPORT_BYTES,
  type RemoteGateGroupReport,
  type Workspace,
  type WorkspaceOutcome,
} from './gate.ts';

const selected: Workspace = {
  name: '@fixture/selected',
  directory: 'apps/selected',
  checkScript: 'bun test',
};
const controlOnly: RemoteGateGroupReport = {
  groupIndex: 0,
  workspaces: [],
  controlPlane: true,
  exitCode: 0,
  report: decodeGateReport(
    JSON.stringify({
      workspaces: [],
      controlPlane: { passed: true, durationSeconds: 0.5, host: 'check-a' },
    }),
  ),
  launched: true,
};

function outcome(workspace: Workspace, host = 'check-a', passed = true): WorkspaceOutcome {
  return {
    name: workspace.name,
    directory: workspace.directory,
    host,
    passed,
    durationSeconds: 1.25,
    failingFiles: passed ? [] : ['test/failure.test.ts'],
    loadSensitiveTests: [],
  };
}

function unknownOutcome(workspace: Workspace): WorkspaceOutcome {
  return {
    name: workspace.name,
    directory: workspace.directory,
    host: 'unknown',
    passed: false,
    durationSeconds: 0,
    failingFiles: [],
    loadSensitiveTests: [],
  };
}

function rawReport(workspaces: unknown[] = [outcome(selected)], controlPlane?: unknown): string {
  return JSON.stringify({
    workspaces,
    ...(controlPlane === undefined ? {} : { controlPlane }),
  });
}

function group(
  workspaceList: Workspace[],
  reportText: string | null,
  options: { controlPlane?: boolean; exitCode?: number; groupIndex?: number; launched?: boolean } = {},
): RemoteGateGroupReport {
  return {
    groupIndex: options.groupIndex ?? 0,
    workspaces: workspaceList,
    controlPlane: options.controlPlane ?? false,
    exitCode: options.exitCode ?? 0,
    report: decodeGateReport(reportText),
    launched: options.launched ?? true,
  };
}

describe('remote gate group report accounting', () => {
  test('zero exit without a report fails closed and records every selected workspace as unknown', () => {
    const result = aggregateRemoteGateReports([group([selected], null)]);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain('group 1: result report is missing');
    expect(result.result.workspaces).toEqual([unknownOutcome(selected)]);
  });

  test('malformed, empty, partial, and oversized reports cannot pass a zero exit', () => {
    const cases = [
      { label: 'malformed JSON', text: '{' },
      { label: 'empty report', text: '' },
      { label: 'partial workspaces', text: rawReport([]) },
      { label: 'oversized report', text: ' '.repeat(MAX_GATE_REPORT_BYTES + 1) },
    ];

    for (const { label, text } of cases) {
      const result = aggregateRemoteGateReports([group([selected], text)]);
      expect(result.exitCode, label).toBe(1);
      expect(result.result.workspaces, label).toEqual([unknownOutcome(selected)]);
    }
  });

  test('invalid outcome types fail closed', () => {
    const invalid = { ...outcome(selected), passed: 'true' };
    const result = aggregateRemoteGateReports([group([selected], rawReport([invalid]))]);

    expect(result.exitCode).toBe(1);
    expect(result.result.workspaces).toEqual([unknownOutcome(selected)]);
  });

  test('duplicate and unexpected outcomes fail closed', () => {
    const duplicate = outcome(selected);
    const cases = [
      [duplicate, duplicate],
      [outcome(selected), outcome({ ...selected, directory: 'packages/unexpected' })],
    ];

    for (const workspaces of cases) {
      const result = aggregateRemoteGateReports([group([selected], rawReport(workspaces))]);
      expect(result.exitCode).toBe(1);
      expect(result.result.workspaces).toEqual([unknownOutcome(selected)]);
    }
  });

  test('an outcome returned by the other group cannot satisfy this group', () => {
    const other: Workspace = {
      name: '@fixture/other',
      directory: 'packages/other',
      checkScript: 'bun test',
    };
    const result = aggregateRemoteGateReports([
      group([selected], rawReport([outcome(other)]), { groupIndex: 0 }),
      group([other], rawReport([outcome(other, 'check-b')]), { groupIndex: 1 }),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.result.workspaces).toEqual([unknownOutcome(selected), outcome(other, 'check-b')]);
  });

  test('a requested control-plane result is required for a zero exit', () => {
    const result = aggregateRemoteGateReports([group([], JSON.stringify({ workspaces: [] }), { controlPlane: true })]);

    expect(result.exitCode).toBe(1);
    expect(result.result.controlPlane).toEqual({ passed: false, durationSeconds: 0, host: 'unknown' });
  });

  test('valid selected-only and control-only reports retain success', () => {
    const selectedResult = aggregateRemoteGateReports([group([selected], rawReport([outcome(selected)]))]);
    const controlResult = aggregateRemoteGateReports([controlOnly]);

    expect(selectedResult.exitCode).toBe(0);
    expect(selectedResult.result).toEqual({ workspaces: [outcome(selected)] });
    expect(controlResult.exitCode).toBe(0);
    expect(controlResult.result).toEqual({
      workspaces: [],
      controlPlane: { passed: true, durationSeconds: 0.5, host: 'check-a' },
    });
  });

  test('an empty unlaunched group needs no report', () => {
    const result = aggregateRemoteGateReports([group([], null, { launched: false })]);

    expect(result.exitCode).toBe(0);
    expect(result.result).toEqual({ workspaces: [] });
  });

  test('a valid failure report keeps its native outcome and exit code', () => {
    const result = aggregateRemoteGateReports([
      group([selected], rawReport([outcome(selected, 'check-a', false)]), { exitCode: 7 }),
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.result.workspaces).toEqual([outcome(selected, 'check-a', false)]);
  });
});
