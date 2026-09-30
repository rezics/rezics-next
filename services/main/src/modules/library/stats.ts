import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE } from '../classification/decision.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { workRead, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { READING_STATS_COST } from './status.ts';

/** A private bounded aggregate. Labels describe the recorded title language,
 * not a guessed original language; page counts have no native projection yet. */
export async function readRichReadingYear(work: MainWorkDependencies, request: Request,
  principal: VerifiedPrincipal, agent: string, year: number) {
  const status = work.libraryStatus;
  if (!status) throw new WorkReadUnavailable('Reader library is unavailable');
  const fence = await status.fence(agent);
  const [base, finished] = await Promise.all([
    status.readingYear(agent, principal, year), status.finishedWorks(agent, year),
  ]);
  const unavailable = { ...base, detailsAvailability: 'unavailable' as const,
    averageRating: null, ratedBooks: null, knownChapters: null, booksWithChapters: null,
    topConcepts: null, titleLanguages: null };
  const checked = async <T>(result: T): Promise<T> => {
    if (await status.fence(agent) !== fence
      || !await work.access.canReadAsBaselineMember?.(principal, agent)) {
      throw new WorkReadMoved('Reading year changed during the read');
    }
    return result;
  };
  if (finished === null) return checked(unavailable);
  if (base.books !== finished.length) throw new WorkReadMoved('Reading year changed during the read');
  try {
    const concepts = new Map<string, number>();
    const languages = new Map<string, number>();
    let ratingTotal = 0, ratedBooks = 0, knownChapters = 0, booksWithChapters = 0;
    for (let start = 0; start < finished.length; start += READING_STATS_COST.detailBatch) {
      const ids = finished.slice(start, start + READING_STATS_COST.detailBatch);
      const part = await workRead(work, request, { actingSubject: agent }, async session => {
        const summaries = await session.summaries(ids);
        if (summaries.some(item => item.status !== 'available' || item.type !== 'work')) {
          throw new WorkReadUnavailable('Finished Work is unavailable');
        }
        const mains = await session.query(`SELECT ?work ?main WHERE {
          VALUES ?work { ${ids.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main . }
        } LIMIT ${READING_STATS_COST.detailBatch + 1}`, READING_STATS_COST.detailBatch + 1);
        if (mains.length !== ids.length || new Set(mains.map(row => row.work?.value)).size !== ids.length) {
          throw new WorkReadUnavailable('Finished Work main version is ambiguous');
        }
        if (!work.libraryRatings) throw new WorkReadUnavailable('Reader ratings are unavailable');
        const ratings = await work.libraryRatings.read(session,
          mains.map(row => ({ work: row.work!.value, main: row.main!.value })));
        const classified = await session.query(`SELECT DISTINCT ?work ?concept WHERE {
          VALUES ?work { ${ids.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} {
            ?work rv:mainVersion ?main .
            ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main ;
              rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
              rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
              rv:decisionHead ?decision ; rv:sense ?sense .
            ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
            ?expression rv:expressionState rv:Active ; rv:assertedConcept ?concept .
          }
          GRAPH ${iri(GRAPHS.revisions)} {
            ?decision a rv:ClassificationDecision ; rv:component ?application ;
              rv:outcome rv:Accepted ; rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
          }
        } LIMIT ${ids.length * READING_STATS_COST.conceptPairsPerWork + 1}`,
        ids.length * READING_STATS_COST.conceptPairsPerWork + 1);
        if (classified.length > ids.length * READING_STATS_COST.conceptPairsPerWork) {
          throw new WorkReadLimit('Reading Concepts exceed the yearly budget');
        }
        const chapters = await work.serialStats?.batch(ids, session.position.sequence);
        return { summaries, ratings, classified, chapters };
      });
      for (const item of part.summaries) {
        if (item.status !== 'available') continue;
        languages.set(item.name.language, (languages.get(item.name.language) ?? 0) + 1);
        const rating = part.ratings.get(item.reference)?.global;
        if (rating?.availability === 'available' && rating.value !== null) {
          ratingTotal += rating.value;
          ratedBooks++;
        }
        const chapters = part.chapters?.get(item.reference)?.chapterCount;
        if (chapters !== null && chapters !== undefined) { knownChapters += chapters; booksWithChapters++; }
      }
      const pairs = new Set<string>();
      for (const row of part.classified) {
        if (!row.work || !row.concept) throw new WorkReadUnavailable('Concept relation is incomplete');
        const key = `${row.work.value}\0${row.concept.value}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        concepts.set(row.concept.value, (concepts.get(row.concept.value) ?? 0) + 1);
      }
    }
    const top = [...concepts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
    const names = top.length ? await workRead(work, request, { actingSubject: agent },
      session => session.summaries(top.map(([concept]) => concept))) : [];
    if (!await work.access.canReadAsBaselineMember?.(principal, agent)) {
      throw new WorkReadMoved('Reader authority changed during the read');
    }
    return checked({ ...base, detailsAvailability: 'complete' as const, averageRating: ratedBooks ? Math.round(ratingTotal / ratedBooks * 10) / 10 : null,
      ratedBooks, knownChapters, booksWithChapters,
      topConcepts: top.flatMap(([concept, count], index) => names[index]?.status === 'available'
        ? [{ name: names[index].name.value, count }] : []),
      titleLanguages: [...languages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([language, count]) => ({ language, count })) });
  } catch (error) {
    // Optional graph enrichment cannot hide the exact SQL totals. Authority
    // and concurrent changes still fail the whole private read.
    if (error instanceof WorkReadLimit || error instanceof WorkReadMissing || error instanceof WorkReadUnavailable) {
      return checked(unavailable);
    }
    throw error;
  }
}
