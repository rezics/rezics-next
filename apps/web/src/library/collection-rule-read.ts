import type { KernelClient } from '@rezics/client';
import type { LibraryProfile } from '@rezics/definitions';
import { parseFilter, type FilterDocument } from '@rezics/filter';
import { conditionMetadata, type ConditionMetadata } from '../search/condition-editor-model';
import type { Release } from '../subject/definitions';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export type SavedRule = {
  filter: FilterDocument;
  sort: 'id';
  revision: number;
  collectionRevision: number;
  releaseDigest: string;
  sourceGeneration: string;
};
export type ChoiceState = 'ready' | 'preparing' | 'unavailable';
export type RuleChoices = {
  release: { state: ChoiceState; metadata?: ConditionMetadata; profiles: LibraryProfile[] };
  labels: { state: ChoiceState; values: { id: string; name: string }[]; next: string | null };
};
export type RulePage =
  | { state: 'new'; choices: RuleChoices; intent: string }
  | { state: 'ready'; id: string; title: string; rule: SavedRule; choices: RuleChoices; intent: string }
  | { state: 'denied' | 'unavailable' };

const preparing = (problem: unknown): ChoiceState => {
  const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
  return code === 'semantic_not_ready' || code === 'index_not_ready' ? 'preparing' : 'unavailable';
};
export const unavailableRuleChoices = (): RuleChoices => ({
  release: { state: 'unavailable', profiles: [] },
  labels: { state: 'unavailable', values: [], next: null },
});

/** Current native choices, one release and one bounded label page. Never an execution/permission preflight. */
export async function loadRuleChoices(
  client: KernelClient,
  authorization: string,
  labels?: { q?: string; cursor?: string },
): Promise<RuleChoices> {
  const result = unavailableRuleChoices();
  await Promise.all([
    (async () => {
      try {
        const active = await client.definitions.active.get({ headers: { authorization } });
        if (active.error || !active.data) {
          result.release.state = preparing(active.error?.value);
          return;
        }
        const response = await client.definitions
          .releases({ digest: active.data.digest })
          .get({ headers: { authorization } });
        if (response.error || !response.data) {
          result.release.state = preparing(response.error?.value);
          return;
        }
        const release = response.data.release as Release;
        result.release = {
          state: 'ready',
          metadata: conditionMetadata(release),
          profiles: Object.values(release.libraryProfiles ?? {}),
        };
      } catch {
        /* Keep unavailable metadata distinct from a ready empty registry. */
      }
    })(),
    (async () => {
      try {
        const response = await client.libraryLabels.get({
          query: { limit: 100, ...labels },
          headers: { authorization },
        });
        if (response.error || !response.data) {
          result.labels.state = preparing(response.error?.value);
          return;
        }
        result.labels = {
          state: 'ready',
          values: response.data.labels.map(({ id, name }) => ({ id, name })),
          next: response.data.next,
        };
      } catch {
        /* No ready empty fallback. */
      }
    })(),
  ]);
  return result;
}

/** The private GET is the sole rule authority; the public Collection DTO never supplies criteria. */
export async function loadCollectionRule(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id?: string,
): Promise<RulePage> {
  try {
    if (await prepareSession(request, sessionEnv)) return { state: 'denied' };
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'denied' };
    if (id === undefined)
      return { state: 'new', choices: await loadRuleChoices(client, authorization), intent: crypto.randomUUID() };
    const response = await client.collections({ collectionId: id }).rule.get({ headers: { authorization } });
    if (response.error || !response.data) return { state: response.status < 500 ? 'denied' : 'unavailable' };
    const rule = response.data.rule;
    const collection = await client.collections({ collectionId: id }).get({ headers: { authorization } });
    if (collection.error || !collection.data) return { state: 'unavailable' };
    return {
      state: 'ready',
      id,
      title: collection.data.collection.title ?? id,
      rule: { ...rule, filter: parseFilter(rule.filter) },
      choices: await loadRuleChoices(client, authorization),
      intent: crypto.randomUUID(),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
