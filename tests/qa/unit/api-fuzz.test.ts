import { expect, test } from 'bun:test';
import { hostLoopbackAccess } from '../../../scripts/load/docker-env.ts';
import { checks, fuzzTimeoutSeconds, parseFuzzArgs, schemathesisArgs, schemathesisImage } from '../../../scripts/qa/api-fuzz.ts';

test('API fuzzing pins its image by digest and runs deterministically against the baseline', () => {
  expect(schemathesisImage).toMatch(/^docker\.io\/schemathesis\/schemathesis:4\.28\.0@sha256:[0-9a-f]{64}$/);
  const args = schemathesisArgs(parseFuzzArgs([]), 'http://127.0.0.1:4000');
  expect(args).toContain('--generation-deterministic');
  expect(args).not.toContain('--seed');
  expect(args.slice(args.indexOf('--checks'), args.indexOf('--checks') + 2)).toEqual(['--checks', checks.join(',')]);
  expect(args.slice(args.indexOf('--baseline'), args.indexOf('--baseline') + 2))
    .toEqual(['--baseline', '/baseline/baseline.json']);
  expect(args).not.toContain('--baseline-update');
  expect(args.slice(args.indexOf('--suppress-health-check'), args.indexOf('--suppress-health-check') + 2))
    .toEqual(['--suppress-health-check', 'filter_too_much']);
  // A time budget would repeat phases; the default is one bounded pass.
  expect(args).not.toContain('--max-time');
  expect(fuzzTimeoutSeconds(parseFuzzArgs([]))).toBe(1020);
});

test('API fuzzing options bound examples and time, and keep seeded runs out of the baseline', () => {
  expect(parseFuzzArgs(['--max-examples', '25', '--seed', '7', '--max-time', '120', '--keep']))
    .toEqual({ maxExamples: 25, seed: 7, maxTime: 120, updateBaseline: false, keep: true });
  const seeded = schemathesisArgs(parseFuzzArgs(['--seed', '7']), 'http://127.0.0.1:4000');
  expect(seeded.slice(seeded.indexOf('--seed'), seeded.indexOf('--seed') + 2)).toEqual(['--seed', '7']);
  expect(seeded).not.toContain('--generation-deterministic');
  expect(schemathesisArgs(parseFuzzArgs(['--update-baseline']), 'http://x:1'))
    .toEqual(expect.arrayContaining(['--baseline-update', '--baseline-prune']));
  expect(fuzzTimeoutSeconds(parseFuzzArgs(['--seed', '7', '--max-time', '120']))).toBe(240);
  expect(() => parseFuzzArgs(['--max-time', '120'])).toThrow('add --seed');
  expect(() => parseFuzzArgs(['--update-baseline', '--seed', '7'])).toThrow('one deterministic pass only');
  expect(() => parseFuzzArgs(['--max-examples', '0'])).toThrow('integer from 1 to 200');
  expect(() => parseFuzzArgs(['--url', 'x'])).toThrow('Unsupported');
});

test('containers reach host loopback services through the daemon-appropriate route', () => {
  expect(hostLoopbackAccess({}, () => 'Docker Desktop')).toEqual({
    args: ['--add-host=host.docker.internal:host-gateway'], host: 'host.docker.internal' });
  expect(hostLoopbackAccess({}, () => 'Fedora Linux 44')).toEqual({ args: ['--network', 'host'], host: '127.0.0.1' });
});
