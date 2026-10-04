import {
  CATALOGUE_IMPORT_COST,
  CATALOGUE_IMPORT_SCOPE,
  type CatalogueImportInput,
} from '../../../services/main/src/modules/work/catalogue-import.ts';
import { seedCatalogueProfileWorks } from '../../../scripts/load/catalogue-work.ts';
import type { CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';

/** Catalogue background through the public bulk command. Ordinary writer,
 * publication and denial proofs keep their small native-command fixtures. */
export async function catalogueFixture(
  api: CorpusApi,
  actingSubject: string,
  grant: (scope: string, action: string) => Promise<unknown>,
  items: readonly { key: string; input: CatalogueImportInput }[],
  afterBatch?: () => Promise<unknown>,
) {
  await grant(CATALOGUE_IMPORT_SCOPE, 'work.create');
  const works: Awaited<ReturnType<typeof seedCatalogueProfileWorks>> = [];
  for (let offset = 0; offset < items.length; offset += CATALOGUE_IMPORT_COST.items) {
    works.push(
      ...(await seedCatalogueProfileWorks(
        api,
        actingSubject,
        items.slice(offset, offset + CATALOGUE_IMPORT_COST.items),
      )),
    );
    // The fixture owns delivery too; never raise the production broker ceiling
    // simply because a background catalogue spans more than one request.
    await afterBatch?.();
  }
  return works;
}
