import type { DiscoveryPage } from '../discovery.ts';
import type { PublicFilterCoveragePage } from '../public-filter-coverage-page.ts';

/** Project every dependent value before the one CURRENT native page final.
 * The native root owns the closed plan, complete child chain and own-row sets;
 * returned hits and diagnostic readStatus are not disclosure authority.
 */
export async function finishDiscoveryDisclosure(
  coverage: PublicFilterCoveragePage,
  project: () => Promise<DiscoveryPage>,
): Promise<DiscoveryPage> {
  const page = await project();
  await coverage.finish();
  return page;
}
