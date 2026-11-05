import { expect, test } from 'bun:test';
import {
  classifyCandidateDelta,
  planCandidateConflicts,
  resolveCandidateTextConflict,
} from './candidate.ts';

test('candidate conflict planning deduplicates generators while retaining ordinary paths', () => {
  expect(
    planCandidateConflicts(
      ['src/example.ts', 'packages/client/a.d.ts', 'contracts/api.json'],
      [
        { path: 'packages/client/**', stage: 'promotion', command: ['bun', 'run', 'generate'] },
        { path: 'contracts/**', stage: 'promotion', command: ['bun', 'run', 'generate'] },
      ],
    ),
  ).toEqual({
    mechanicalPaths: ['src/example.ts'],
    derivedPaths: ['packages/client/a.d.ts', 'contracts/api.json'],
    commands: [['bun', 'run', 'generate']],
  });
});

test('candidate text resolution preserves flat message additions and reports incompatible values', () => {
  const merge = (ours: string, theirs: string) =>
    resolveCandidateTextConflict(
      'apps/web/messages/en.json',
      '',
      ['{"shared":"base"}', ours, theirs],
      true,
    );
  const resolved = merge(
    '{"shared":"base","worker":"value"}',
    '{"shared":"base","dev":"value"}',
  );
  expect(resolved).toMatchObject({ ok: true, taskChangeDropped: false });
  if (resolved?.ok) expect(JSON.parse(resolved.text)).toEqual({ shared: 'base', worker: 'value', dev: 'value' });
  expect(merge('{"shared":"worker"}', '{"shared":"dev"}')).toEqual({
    ok: false,
    reason: 'JSON message conflict in apps/web/messages/en.json: key shared',
  });
});

test('candidate delta classification shares empty, partial, and effective outcomes', () => {
  expect(classifyCandidateDelta(['a.ts', 'b.ts'], ['a.ts', 'b.ts'], [])).toEqual({
    kind: 'already-present',
    paths: ['a.ts', 'b.ts'],
  });
  expect(classifyCandidateDelta(['a.ts', 'b.ts'], ['a.ts', 'b.ts'], ['a.ts'])).toEqual({
    kind: 'partial-no-effect',
    paths: ['b.ts'],
  });
  expect(classifyCandidateDelta(['a.ts'], ['a.ts'], ['a.ts'])).toEqual({ kind: 'effective' });
});
