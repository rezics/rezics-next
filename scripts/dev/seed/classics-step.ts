import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceChildOccurrence } from '../../../services/main/src/modules/source/child-correspondence.ts';
import type { FixtureLock } from '../../fixtures/pull.ts';
import { demoClassics } from '../../../tests/fixtures/sources/open-library.ts';
import { grantImportedWorkSeedAuthority } from './operator.ts';
import { openLibraryFixtureFetch } from './open-library-fixtures.ts';
import { seedKey } from './plan.ts';
import type { SeedState, WorkReceipt } from './state.ts';

const shortId = (uri: string) => uri.slice(-36);

interface Observation { observation: string; byteDigest: string | null;
  capture?: { profile: string; url: string; fetchedAt: string } }
interface Conversion { conversion: string; projection: {
  title: string; authorRefs: { sourceKey: string; roleKey: string | null }[] | null } }
interface Proposal { proposal: string; observation: string; conversion: string;
  candidateTitle: string }

/** Acquire every demo classic through Main's source route and verify its fixture receipt. */
export async function seedClassics(state: SeedState): Promise<void> {
  if (!state.operatorSession || !state.operatorInput) {
    throw new Error('Classic acquisition requires the local fixture operator');
  }
  const root = resolve(import.meta.dir, '../../..');
  const lock = JSON.parse(readFileSync(`${root}/tests/fixtures/fixtures.lock.json`, 'utf8')) as FixtureLock;
  const entries = new Map(lock.entries.filter(entry => entry.source === 'open-library')
    .map(entry => [entry.id, entry]));
  const fixtureFetch = openLibraryFixtureFetch(root);
  const { api, token } = state.operatorSession;
  const actor = state.operatorInput.actingSubject;
  await grantImportedWorkSeedAuthority(state.operatorInput);
  const namedAuthors = new Set<string>();

  for (const classic of demoClassics) {
    const workEntry = entries.get(`work-${classic.work}`);
    if (!workEntry) throw new Error(`Locked Work fixture missing: ${classic.work}`);
    const edition = await fixtureFetch(`https://openlibrary.org/books/${classic.edition}.json`)
      .then(response => response.json()) as { works?: { key?: string }[] };
    if (!edition.works?.some(item => item.key === `/works/${classic.work}`)) {
      throw new Error(`Edition ${classic.edition} does not refer to ${classic.work}`);
    }
    const capture = await api.post<{ observation: Observation; replayed: boolean }>(
      '/v1/sources/acquisitions/open-library/works',
      { profile: 'open-library-work-acquisition-v1', workId: classic.work },
      token, seedKey('source-acquisition', classic.id));
    const observation = capture.observation;
    if (observation.byteDigest !== workEntry.sha256
      || observation.capture?.profile !== 'open-library-work-acquisition-v1'
      || observation.capture.url !== workEntry.requestUrl) {
      throw new Error(`Acquisition receipt for ${classic.id} does not match the locked fixture`);
    }
    const conversion = (await api.post<{ conversion: Conversion }>(
      `/v1/sources/observations/${shortId(observation.observation)}/conversions/open-library-work`,
      { profile: 'open-library-work-map-v1' }, token,
      seedKey('source-conversion', classic.id))).conversion;
    if (!conversion.projection.authorRefs?.length) {
      throw new Error(`Source conversion for ${classic.id} has no authors`);
    }
    await api.post(`/v1/sources/conversions/${shortId(conversion.conversion)}/source-graph`,
      { profile: 'source-open-library-work-v1' }, token, seedKey('source-graph', classic.id));
    const proposal = (await api.post<{ proposal: Proposal }>(
      `/v1/sources/conversions/${shortId(conversion.conversion)}/proposals/native-work`,
      { profile: 'open-library-native-work-proposal-v1' }, token,
      seedKey('source-proposal', classic.id))).proposal;
    const adopted = await api.post<{ adoption: WorkReceipt; replayed: boolean }>(
      `/v1/sources/proposals/${shortId(proposal.proposal)}/adoption/native-work`,
      { profile: 'source-native-work-adoption-v1', actingSubject: actor,
        confirmedTitle: proposal.candidateTitle },
      token, seedKey('source-adoption', classic.id));
    const receipt = { ...adopted.adoption, replayed: adopted.replayed };
    state.created.set(classic.id, receipt);
    await grantImportedWorkSeedAuthority(state.operatorInput, receipt.work, receipt.mainVersion);

    for (const [ordinal, author] of conversion.projection.authorRefs.entries()) {
      const authorId = author.sourceKey.match(/^\/authors\/(OL[1-9][0-9]*A)$/)?.[1];
      if (!authorId || !entries.has(`author-${authorId}`)) {
        throw new Error(`Author fixture missing for ${classic.id}: ${author.sourceKey}`);
      }
      if (!namedAuthors.has(authorId)) {
        const name = await api.post<{ name: { nameSource: { digest: string } } | null }>(
          `/v1/sources/open-library/authors/${authorId}/name`,
          { action: 'refresh', expectedRevision: null }, token,
          seedKey('source-author-name', authorId));
        if (name.name?.nameSource.digest !== entries.get(`author-${authorId}`)?.sha256) {
          throw new Error(`Author acquisition for ${authorId} does not match the locked fixture`);
        }
        namedAuthors.add(authorId);
      }
      await api.post(`/v1/works/${shortId(receipt.work)}/source-author-credits`, {
        profile: 'source-author-credit-adoption-v1', proposal: proposal.proposal,
        conversion: proposal.conversion, expectedHead: receipt.workRevision,
        actingSubject: actor, sourceOrdinal: ordinal, nativeOrdinal: ordinal,
        occurrence: sourceChildOccurrence(proposal.observation, 'authors', ordinal),
        confirmedSourceKey: author.sourceKey, confirmedRoleKey: author.roleKey,
        baseSupport: null, correspondence: null, confirmedUse: 'factual-reference-only',
      }, token, seedKey('source-author-credit', `${classic.id}-${ordinal}`));
    }
    console.log(`Classic ${classic.id}: ${receipt.work} via ${classic.work}; acquisition ${
      shortId(observation.observation)}${capture.replayed ? ' (replayed)' : ''}`);
  }
}
