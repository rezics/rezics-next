import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { GLOBAL, preparedRatingReader, ratingFailure, type Figure, type RatingOutcome } from './subject-ratings';
import { admitRatingAggregate, admitRatingPopulationPage } from './rating-population-value';

export const POPULATION_LIMIT = 20;
export type PopulationInput = {
  id: string;
  question: string;
  expectedReader: string | null;
  locale: string;
  cursor?: string | undefined;
  selected?: string[] | undefined;
};
export type PopulationItem = { id: string; name: string; figure: RatingOutcome<Figure> };
export type PopulationResult = {
  items: PopulationItem[];
  next: string | null;
  /** Refused identities and their counts are omitted, even if the aggregate returned a masked zero. */
  incomplete: boolean;
};
export type PopulationEnvelope = {
  reader: string | null;
  subject: string;
  question: string;
  result: RatingOutcome<PopulationResult>;
};

/** Expected reader is a comparison operand, never an authentication or freshness assertion. */
export async function readRatingPopulations(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: PopulationInput,
): Promise<PopulationEnvelope> {
  let reader: string | null = null;
  const envelope = (result: RatingOutcome<PopulationResult>): PopulationEnvelope => ({
    reader,
    subject: input.id,
    question: input.question,
    result,
  });
  try {
    // Keep exactly this Request across preparation, credential extraction and provenance derivation.
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    reader = await preparedRatingReader(request, authorization);
    if (reader !== input.expectedReader) return envelope({ kind: 'unavailable' });
    const headers: Record<string, string> = authorization ? { authorization } : {};
    const subject = client.subjects({ id: input.id });
    const selected = input.selected;
    if (
      selected &&
      (selected.length > POPULATION_LIMIT || new Set(selected).size !== selected.length || selected.includes(GLOBAL))
    )
      return envelope({ kind: 'failed' });

    async function labels(ids: string[]) {
      return Promise.all(
        ids.map(async (id) => {
          try {
            // Use the installed generated Realm route; a population's presence/count grants no Realm read.
            const result = await client.realms({ realmId: id }).get({ headers });
            return result.status === 200 && result.data?.realm.realmId === id
              ? { id, name: result.data.realm.title }
              : null;
          } catch {
            return null;
          }
        }),
      );
    }

    if (selected !== undefined) {
      if (selected.length === 0)
        return envelope({ kind: 'ready', value: { items: [], next: null, incomplete: false } });
      const [currentLabels, aggregate] = await Promise.all([
        labels(selected),
        subject.ratings
          .get({ query: { question: input.question, population: selected }, headers })
          .then((response) => ({ response }))
          .catch(() => ({ response: undefined })),
      ]);
      const response = aggregate.response;
      const body =
        response?.status === 200
          ? admitRatingAggregate(response.data, {
              subject: input.id,
              question: input.question,
              populations: selected,
            })
          : null;
      if (response?.status === 200 && !body) return envelope({ kind: 'failed' });
      const items: PopulationItem[] = [];
      for (const label of currentLabels) {
        if (!label) continue;
        const value = body?.figures.find((figure) => figure.population === label.id);
        items.push({ ...label, figure: value ? { kind: 'ready', value } : ratingFailure(response?.status ?? 503) });
      }
      return envelope({
        kind: 'ready',
        value: {
          items,
          next: null,
          incomplete: currentLabels.some((label) => label === null),
        },
      });
    }

    // No hidden refill: sparse/empty pages retain the exact opaque continuation from this one native page.
    const result = await subject.ratings.populations.get({
      query: { question: input.question, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
      headers,
    });
    if (result.status !== 200) return envelope(ratingFailure(result.status));
    const page = admitRatingPopulationPage(result.data);
    if (!page) return envelope({ kind: 'failed' });
    const ids = page.populations.map((item) => item.population).filter((id) => id !== GLOBAL);
    const currentLabels = await labels(ids);
    return envelope({
      kind: 'ready',
      value: {
        items: currentLabels.flatMap((label) => (label ? [{ ...label, figure: { kind: 'idle' as const } }] : [])),
        next: page.next,
        incomplete: currentLabels.some((label) => label === null),
      },
    });
  } catch {
    return envelope({ kind: 'failed' });
  }
}
