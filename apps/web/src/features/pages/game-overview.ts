import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { gameReaderEditionPage, type GameReaderRead } from '../catalogue/game-reader/model';
import { pageContext, type SubjectPageData } from './page-model';

/** Reuse the already planned inverse window, including a source-local failure. No release target hydration. */
export function gameOverviewInitial(
  page: SubjectPageData,
  initial: GameReaderRead | undefined,
): GameReaderRead | undefined {
  if (!initial?.ok || !initial.admitted) return initial;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const planned = Object.entries(plan.reads).find(
    ([, read]) => read.kind === 'links' && read.property === 'schema:exampleOfWork' && read.id === page.subject,
  );
  if (!planned) return initial;
  const response = page.reads[planned[0]];
  const common = { ...initial, editionsAdmitted: true };
  const result = gameReaderEditionPage(
    common,
    {
      id: initial.public.subject.id,
      context: initial.public.subject.context,
      type: initial.public.subject.type,
    },
    response?.status ?? 503,
    response?.body,
  );
  return result.ok || result.reason !== 'unavailable' ? result : { ...common, editionFailure: result };
}
