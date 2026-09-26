import { npmCompositionDocuments, npmCompositionRequest } from './npm-composition-snapshot.ts';
import { npmPackage } from './npm-lock-snapshot.ts';

export type NpmPolicyCase = 'override' | 'engine-incompatible' | 'nested-override'
  | 'direct-conflict' | 'missing-provenance' | 'absent-override' | 'malformed-override'
  | 'range-override' | 'override-budget' | 'engine-range';
export const npmPolicyCases: NpmPolicyCase[] = ['override', 'engine-incompatible',
  'nested-override', 'direct-conflict', 'missing-provenance'];

export function npmPolicyFixture(kind: NpmPolicyCase = 'override') {
  const docs = npmCompositionDocuments('optional-alias-child');
  docs.manifest.overrides = { leaf: '2.0.0' };
  docs.lock.packages['node_modules/leaf'] = {
    ...npmPackage('leaf', '2.0.0'), optional: true,
    engines: { node: '>=20.0.0', npm: '>=11.0.0' },
  };
  if (kind === 'engine-incompatible') {
    docs.lock.packages['node_modules/leaf']!.engines = { node: '>=30.0.0' };
  }
  if (kind === 'nested-override') docs.manifest.overrides = { renamed: { leaf: '2.0.0' } };
  if (kind === 'direct-conflict') docs.manifest.overrides = { renamed: '2.0.0' };
  if (kind === 'missing-provenance') delete docs.lock.packages['node_modules/leaf']!.integrity;
  if (kind === 'absent-override') delete docs.manifest.overrides;
  if (kind === 'malformed-override') docs.manifest.overrides = { leaf: 2 };
  if (kind === 'range-override') docs.manifest.overrides = { leaf: '^2.0.0' };
  if (kind === 'override-budget') docs.manifest.overrides = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`unused${index}`, '1.0.0']));
  if (kind === 'engine-range') docs.lock.packages['node_modules/leaf']!.engines = { node: '^20.0.0' };
  return { ...npmCompositionRequest(docs), profile: 'npm-lock-v3-topology-v5' as const,
    policy: 'literal-sources-policy-v5',
    engineTarget: { nodeVersion: '26.8.2', npmVersion: '11.19.1' } };
}
