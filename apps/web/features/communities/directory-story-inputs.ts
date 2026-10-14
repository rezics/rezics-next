import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import { direction } from '@rezics/main/language';
import { browseCategories } from '../catalogue/registry.ts';
import { servedTypes } from '../catalogue/type-fixtures.ts';
import type { ResourceCard, ServedPage } from '../discover/api.ts';
import { browseQuery, emptyBrowse, type BrowseState } from '../discover/browse-state.ts';
import { creationSample, foundingPersonas } from './creation-story-inputs.ts';

export type DirectoryStoryState = 'populated' | 'continuation' | 'filtered' | 'empty' | 'error' | 'moved' | 'loading';
const position = { dataEpoch: 'directory-story', sequence: '1' };
function liveCard(id: string, value: string): ResourceCard {
  const realmTypes = browseCategories(servedTypes.types).find(category => category.id === 'communities')?.types;
  if (!realmTypes) throw new Error('The served registry must declare the communities category');
  return { id, name: { value, language: 'en', direction: direction('en', value), basis: 'fallback' }, kind: 'realm', types: realmTypes,
    icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: id, resourceType: 'realm' } };
}
const publicAddress = creationSample('visitor', 'public-created-address').answer as {
  capabilities: { realm: string }; canonical: { suffixSource: string };
};
export const directoryLiveCards = [liveCard(publicAddress.capabilities.realm, publicAddress.canonical.suffixSource),
  liveCard('https://rezics.com/id/00000000-0000-8000-8000-000000000903', 'Original public reading circle 2')];
export const closedDirectoryIdentity = 'https://rezics.com/id/00000000-0000-8000-8000-000000000904';
export const privateCreationIdentities = foundingPersonas.map(persona =>
  (creationSample(persona, 'creation-receipt').answer as { realm: string }).realm);

/** Closure directory answers are not recorded yet. These are explicit
 * contract states, using the visitor's public address and synthetic public
 * Realms. Founders' private recorded Realms must never supply visitor rows. */
export function directoryStoryInputs(persona: AnswerPersona, mode: DirectoryStoryState = 'populated') {
  const state: BrowseState = { ...emptyBrowse, tab: 'communities',
    ...(mode === 'continuation' ? { cursor: 'directory-next-page' } : {}),
    ...(mode === 'filtered' ? { q: 'Original', conditions: { include: ['00000000-0000-8000-8000-000000000901'], exclude: [], match: 'all' } } : {}),
    ...(mode === 'empty' ? { q: 'no-matching-live-realms' } : {}),
  };
  const body = browseQuery(state, 1);
  const page: ServedPage<ResourceCard, 'resource-list-v1'> = {
    profile: 'resource-list-v1', sourcePosition: position, stale: false,
    items: mode === 'empty' ? [] : [directoryLiveCards[mode === 'continuation' ? 1 : 0]!],
    count: { kind: mode === 'continuation' || mode === 'empty' ? 'exact' : 'at-least',
      value: mode === 'empty' ? 0 : mode === 'continuation' ? 2 : 1 },
    complete: mode === 'continuation' || mode === 'empty',
    nextCursor: mode === 'continuation' || mode === 'empty' ? null : 'directory-next-page',
  };
  const sample: AnswerSample = { label: 'directory', operationId: 'postV1Query', method: 'POST', path: '/v1/query', body,
    status: mode === 'error' ? 503 : mode === 'moved' ? 409 : 200,
    answer: mode === 'error' || mode === 'moved'
      ? { type: 'about:blank', status: mode === 'error' ? 503 : 409,
        title: mode === 'error' ? 'Read is unavailable' : 'Read basis changed',
        code: mode === 'error' ? 'read_unavailable' : 'read_basis_changed' }
      : { result: page }, headers: { 'content-type': 'application/json' } };
  const record: AnswerRecord = { version: 1, row: 'realm/closure-directory',
    personas: { visitor: [], stranger: [], member: [], owner: [], moderator: [], operator: [], [persona]: [sample] } };
  return { state, body, page, sample, record, persona, mode, missingRecordedStates: [sample],
    requiredState: { closedRealms: [closedDirectoryIdentity], livePublicRealms: directoryLiveCards.map(card => card.id) } };
}
