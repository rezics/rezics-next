import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { independentRestorePreparationOptions, ownerErasurePreparationOptions, RetainedSources } from './retained-source.ts';
import type { RetainedRequirement } from './retained-preflight.ts';
import { needsRealmDiscussionSource, smallRecoveryFixtureConsumers } from './preparation-selection.ts';
import { auditConsumerForFile } from '../../tests/qa/fixtures/audit-corpus-contract.ts';

/** Walk authored relative imports without evaluating tests (which may bootstrap
 * personas at module scope). Stop at source APIs; their implementations import
 * other producers as utilities, not as consumer dependencies. */
export function retainedRequirementKinds(root: string, files: readonly string[]): string[] {
  const kinds = new Set<string>(), visited = new Set<string>();
  if (Object.values(smallRecoveryFixtureConsumers(files, process.env)).some(Boolean)) kinds.add('fixture-small');
  const apis: Record<string, string> = {
    'tests/qa/support/realm-discussion-source.ts': 'realm',
    'tests/qa/support/seed-checkpoints.ts': 'seed',
    'tests/qa/fault-recovery/retained-content-source-consumer.ts': 'content',
  };
  const visit = (file: string) => {
    if (visited.has(file) || !file.startsWith('tests/qa/') || !existsSync(join(root, file))) return;
    visited.add(file);
    if (apis[file]) { kinds.add(apis[file]); return; }
    if (file.endsWith('-source-support.ts') || file.endsWith('owner-restore-erasure-fixture.ts')
      || file.endsWith('independent-restore-support.ts')) return;
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g)) {
      const path = relative(root, resolve(root, dirname(file), match[1]!));
      visit(existsSync(join(root, path)) ? path : `${path}.ts`);
    }
  };
  for (const file of files) {
    // Producers and unit contracts do not consume retained data.
    if (!file.startsWith('tests/qa/integration/') && !file.startsWith('tests/qa/fault-recovery/')) continue;
    if (file.endsWith('-preparation.test.ts') || file.endsWith('work-profile-seed-build.test.ts')
      || file === 'tests/qa/integration/realm-discussion-source.test.ts') continue;
    const independent = independentRestorePreparationOptions(file);
    if (independent) kinds.add(independent.withRecipe ? 'independent-recipe' : 'independent-authority');
    const owner = ownerErasurePreparationOptions(file);
    if (owner) kinds.add(owner.laterApiAdmission ? 'owner-later' : 'owner');
    if (auditConsumerForFile(file)) kinds.add('audit');
    visit(file);
  }
  return [...kinds].sort();
}

export function retainedRequirements(root: string, files: readonly string[], custodyRoot = root): RetainedRequirement[] {
  const fixtureDirectory = process.env.REZICS_FIXTURE_ROOT ?? join(custodyRoot, '.temp', 'fixture');
  return retainedRequirementKinds(root, files).map(kind => ({
    source: kind,
    ...(kind === 'fixture-small' ? { preparedByRun: 'small fixture before fault/recovery shards' } : {}),
    ...(kind === 'realm' && needsRealmDiscussionSource(files)
      ? { preparedByRun: 'Realm discussion source before integration shards' } : {}),
    build: kind === 'audit' ? 'task goal -- prepare-audit prepare'
      : kind === 'realm' ? 'task goal -- test tests/qa/integration/realm-discussion-source.test.ts'
      : kind === 'seed' ? 'task goal -- test tests/qa/fault-recovery/work-profile-seed-build.test.ts'
      : kind === 'content' ? 'task goal -- test tests/qa/fault-recovery/retained-content-source-preparation.test.ts'
      : `task goal -- prepare-source ${kind}`,
    async check() {
      if (kind === 'audit') {
        const { preflightAuditCorpus } = await import('./fixtures/audit-corpus.ts');
        return preflightAuditCorpus(custodyRoot);
      }
      if (kind === 'fixture-small') {
        const { compatibleFixture } = await import('../fixture/restore.ts');
        const { verifyFixtureCustody } = await import('../fixture/custody.ts');
        const { dockerEnvironment } = await import('../fixture/stack.ts');
        const manifest = compatibleFixture('small', undefined, fixtureDirectory);
        if (!manifest) throw new Error('small fixture build is missing or stale for the frozen owner/schema/image inputs');
        verifyFixtureCustody(manifest, dockerEnvironment(), join(fixtureDirectory, manifest.id));
        return manifest.id;
      }
      if (kind === 'realm') {
        const runtime = await import('../../tests/qa/support/realm-discussion-source-runtime.ts');
        const { realmDiscussionSourceAdapter } = await import('../../tests/qa/support/realm-discussion-source.ts');
        const adapter = realmDiscussionSourceAdapter(await runtime.realmSourceInputs(root), runtime.realmSourceRuntime('preflight'));
        return (await new RetainedSources(join(custodyRoot, '.temp', 'realm-discussion-sources')).preflight(adapter)).key;
      }
      if (kind === 'seed') {
        const { preflightSeedCheckpoints } = await import('./seed-preflight.ts');
        return preflightSeedCheckpoints(root);
      }
      const { dockerEnvironment } = await import('../fixture/stack.ts');
      if (kind === 'content') {
        const { retainedContentSourceAdapter } = await import('../../tests/qa/fault-recovery/retained-content-source-support.ts');
        const directory = join(custodyRoot, '.temp', 'fixture', 'retained-sources');
        return (await new RetainedSources(directory).preflight(
          retainedContentSourceAdapter(directory, dockerEnvironment()))).key;
      }
      if (kind.startsWith('independent')) {
        const { independentRestoreSourceAdapter } = await import('../../tests/qa/fault-recovery/independent-restore-support.ts');
        return (await new RetainedSources(join(fixtureDirectory, 'retained-sources')).preflight(independentRestoreSourceAdapter(kind === 'independent-recipe'))).key;
      }
      const { ownerErasureSourceAdapter } = await import('../../tests/qa/fault-recovery/owner-restore-erasure-fixture.ts');
      return (await new RetainedSources(join(fixtureDirectory, 'retained-sources')).preflight(ownerErasureSourceAdapter(
        { laterApiAdmission: kind === 'owner-later' }, dockerEnvironment()))).key;
    },
  }));
}
