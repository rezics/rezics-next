import { expect, test } from 'bun:test';
import { HubDependencyInvalid, lowerSkillDependencies, type HubDependencyRequest }
  from '../../../services/main/src/modules/hub/deps.ts';

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
      { ordinal: 0, ecosystem: 'npm', strength: 'required', declaration: 'declared' },
      { ordinal: 1, ecosystem: 'cargo', strength: 'required', declaration: 'declared' },
    ]);
  expect(lowered).toEqual({ request: { profile: 'rezics-package-lock-v1', segments: [
    { ecosystem: 'npm', resolution: first, scope: { kind: 'process', label: 'node-runtime' } },
    { ecosystem: 'cargo', resolution: second, scope: { kind: 'abi', label: 'native-host' } },
  ] }, subject: { revision, requirementMappings: [
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
