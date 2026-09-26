import { expect, test } from 'bun:test';
import { HubDependencyInvalid, lowerSkillDependencies, type HubDependencyRequest }
  from '../../../services/main/src/modules/hub/deps.ts';
import { HubInvalid, inspectSkillPackageRequirements }
  from '../../../services/main/src/modules/hub/store.ts';

const revision = '00000000-0000-4000-8000-000000000001';
const actingSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const first = '00000000-0000-4000-8000-000000000003';
const second = '00000000-0000-4000-8000-000000000004';

test('HUB03/PKG18: ecosystem requirements lower to distinct scoped lock segments', () => {
  const lowered = lowerSkillDependencies({ profile: 'hub-dependency-lock-v1', revision, actingSubject,
    segments: [
      { ecosystem: 'npm', resolution: first, scope: { kind: 'process', label: 'node-runtime' }, requirements: [0] },
      { ecosystem: 'cargo', resolution: second, scope: { kind: 'abi', label: 'native-host' }, requirements: [1] },
    ] }, [
      { ordinal: 0, ecosystem: 'npm', nativeSelector: '^1.0.0', target: { name: 'shared' },
        strength: 'required', declaration: 'declared', sourcePath: 'rezics.package-requirements.json',
        sourcePointer: '/requirements/0' },
      { ordinal: 1, ecosystem: 'cargo', nativeSelector: '=1.0.0', target: { name: 'shared' },
        strength: 'required', declaration: 'declared', sourcePath: 'rezics.package-requirements.json',
        sourcePointer: '/requirements/1' },
    ]);
  expect(lowered).toEqual({ request: { profile: 'rezics-package-lock-v1', segments: [
    { ecosystem: 'npm', resolution: first, scope: { kind: 'process', label: 'node-runtime' } },
    { ecosystem: 'cargo', resolution: second, scope: { kind: 'abi', label: 'native-host' } },
  ] }, subject: { revision, requirements: [
    { ordinal: 0, ecosystem: 'npm', nativeSelector: '^1.0.0', target: { name: 'shared' },
      strength: 'required', declaration: 'declared', sourcePath: 'rezics.package-requirements.json',
      sourcePointer: '/requirements/0' },
    { ordinal: 1, ecosystem: 'cargo', nativeSelector: '=1.0.0', target: { name: 'shared' },
      strength: 'required', declaration: 'declared', sourcePath: 'rezics.package-requirements.json',
      sourcePointer: '/requirements/1' },
  ], requirementMappings: [
    { requirementOrdinal: 0, segmentOrdinal: 0 }, { requirementOrdinal: 1, segmentOrdinal: 1 },
  ] } });
});

test('HUB03/PKG18: duplicate scopes are rejected and different scopes remain independent', () => {
  expect(() => lowerSkillDependencies({ profile: 'hub-dependency-lock-v1', revision, actingSubject,
    segments: [
      { ecosystem: 'npm', resolution: first, scope: { kind: 'process', label: 'shared' }, requirements: [] },
      { ecosystem: 'cargo', resolution: second, scope: { kind: 'process', label: 'shared' }, requirements: [] },
    ] })).toThrow(HubDependencyInvalid);
  expect(lowerSkillDependencies({ profile: 'hub-dependency-lock-v1', revision, actingSubject,
    segments: [{ ecosystem: 'npm', resolution: first, scope: { kind: 'path', label: 'js' }, requirements: [] },
      { ecosystem: 'cargo', resolution: second, scope: { kind: 'abi', label: 'native' }, requirements: [] }] }, [])
    .request.segments.map(item => item.ecosystem)).toEqual(['npm', 'cargo']);
  const unsupported = JSON.parse(JSON.stringify({ profile: 'hub-dependency-lock-v1', revision, actingSubject,
    segments: [{ ecosystem: 'nix', resolution: first, scope: { kind: 'path', label: 'nix' }, requirements: [] }] })) as
    HubDependencyRequest;
  expect(() => lowerSkillDependencies(unsupported, [])).toThrow(HubDependencyInvalid);
});

test('HUB03: required declarations need a matching ecosystem segment; optional declarations may be omitted', () => {
  const request = { profile: 'hub-dependency-lock-v1' as const, revision, actingSubject,
    segments: [{ ecosystem: 'npm' as const, resolution: first,
      scope: { kind: 'process' as const, label: 'js' }, requirements: [] }] };
  const requirement = { ordinal: 0, ecosystem: 'cargo', strength: 'required' as const, declaration: 'declared' as const };
  expect(() => lowerSkillDependencies(request, [requirement])).toThrow(HubDependencyInvalid);
  expect(() => lowerSkillDependencies(request, [{ ...requirement, ecosystem: 'npm' }]))
    .toThrow(HubDependencyInvalid);
  expect(lowerSkillDependencies(request, [{ ...requirement, ecosystem: 'npm', strength: 'optional' }])
    .subject.requirementMappings).toEqual([]);
});

test('HUB03: more than sixteen profile segments exceeds the declared operation bound', () => {
  const segments = Array.from({ length: 17 }, (_, index) => ({ ecosystem: 'npm' as const,
    resolution: first, scope: { kind: 'process' as const, label: `runtime-${index}` }, requirements: [] }));
  expect(() => lowerSkillDependencies({ profile: 'hub-dependency-lock-v1', revision, actingSubject, segments }, []))
    .toThrow(HubDependencyInvalid);
});

test('HUB03/PKG18: Skill sidecar preserves native selectors and marks unsupported adapters', () => {
  const sidecar = { profile: 'rezics-skill-package-requirements-v1', requirements: [
    { ecosystem: 'npm', selector: '^1.2.0', target: { name: 'tiny' }, strength: 'required' },
    { ecosystem: 'pypi', selector: '>=2', target: { name: 'sample' }, strength: 'optional' },
  ] };
  expect(inspectSkillPackageRequirements([{ path: 'rezics.package-requirements.json',
    bytes: Buffer.from(JSON.stringify(sidecar)) }])).toEqual([
    { ecosystem: 'npm', nativeSelector: '^1.2.0', target: { name: 'tiny' }, strength: 'required',
      declaration: 'declared', sourcePath: 'rezics.package-requirements.json', sourcePointer: '/requirements/0' },
    { ecosystem: 'pypi', nativeSelector: '>=2', target: { name: 'sample' }, strength: 'optional',
      declaration: 'unsupported', sourcePath: 'rezics.package-requirements.json', sourcePointer: '/requirements/1' },
  ]);
});

test('HUB03: malformed or ambiguous requirement sidecars are rejected', () => {
  for (const value of [
    '{"profile":"rezics-skill-package-requirements-v1","profile":"other","requirements":[]}',
    JSON.stringify({ profile: 'wrong', requirements: [] }),
    JSON.stringify({ profile: 'rezics-skill-package-requirements-v1', requirements: [
      { ecosystem: 'npm', selector: ' ', target: {}, strength: 'required' },
      { ecosystem: 'npm', selector: ' 1.0.0 ', target: { name: 'shared' }, strength: 'required' },
    ] }),
  ]) {
    expect(() => inspectSkillPackageRequirements([{ path: 'rezics.package-requirements.json',
      bytes: Buffer.from(value) }])).toThrow(HubInvalid);
  }
  expect(inspectSkillPackageRequirements([{ path: 'SKILL.md', bytes: Buffer.from('---\n---') }])).toEqual([]);
});

test('HUB03: sidecar parsing admits 256 bounded requirements and rejects the next one', () => {
  const requirement = { ecosystem: 'npm', selector: '^1.0.0', target: { name: 'shared' }, strength: 'required' };
  const sidecar = (count: number) => Buffer.from(JSON.stringify({
    profile: 'rezics-skill-package-requirements-v1', requirements: Array.from({ length: count }, () => requirement),
  }));
  expect(inspectSkillPackageRequirements([{ path: 'rezics.package-requirements.json', bytes: sidecar(256) }]))
    .toHaveLength(256);
  expect(() => inspectSkillPackageRequirements([{ path: 'rezics.package-requirements.json', bytes: sidecar(257) }]))
    .toThrow(HubInvalid);
  expect(() => inspectSkillPackageRequirements([{ path: 'rezics.package-requirements.json',
    bytes: Buffer.alloc(65_537) }])).toThrow(HubInvalid);
});
