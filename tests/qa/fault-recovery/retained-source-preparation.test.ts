import { expect, test } from 'bun:test';
import { RetainedSources } from '../../../scripts/qa/retained-source.ts';
import { independentRestoreSourceAdapter } from './independent-restore-support.ts';
import { ownerErasureSourceAdapter } from './owner-restore-erasure-fixture.ts';

// Explicit publication uses the normal admitted QA bootstrap. Consumers never
// run this file implicitly, and each repair command selects just its variant.
for (const kind of ['owner', 'owner-later', 'independent-recipe', 'independent-authority'] as const) {
  test(`prepare retained ${kind}`, async () => {
    const sources = new RetainedSources();
    const result = kind.startsWith('independent')
      ? await sources.prepare(independentRestoreSourceAdapter(kind === 'independent-recipe'))
      : await sources.prepare(ownerErasureSourceAdapter({ laterApiAdmission: kind === 'owner-later' }));
    expect(result.manifest.key).toStartWith('rs-');
    console.log(JSON.stringify({ key: result.manifest.key, built: result.built, elapsedMs: result.elapsedMs }));
  }, 1_320_000);
}
