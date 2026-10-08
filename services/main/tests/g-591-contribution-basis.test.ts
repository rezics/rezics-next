import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { publishTextContribution, textPublicationDigest } from '../src/modules/contribution/publish.ts';
import { CONTRIBUTION_PROFILE, textContributionDigest, textContributionReceiptIri }
  from '../src/modules/contribution/draft.ts';
import { DATASET, prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { TranslationBasisRequired } from '../src/modules/work/translation-links.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const basisAdmission = '00000000-0000-4000-8000-0000000000a1';
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const plain = (value: string) => ({ type: 'literal', value, datatype: 'http://www.w3.org/2001/XMLSchema#string' });
const integer = (value: string) => ({ type: 'literal', value, datatype: 'http://www.w3.org/2001/XMLSchema#integer' });

test('G-591: another author’s translation basis is checked before a text publication writes', async () => {
  const contribution = id(), work = id(), author = id(), head = id();
  const directory = `.temp/g-591-unit-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  const manifest = prepareComponent(directory, contribution,
    { work, author, language: 'zh', body: '译文正文', publication: 'draft' }, CONTRIBUTION_PROFILE);
  let probes = 0, commands = 0;
  class TranslationGraph extends FusekiClient {
    override async commandHealth() {
      return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: randomUUID(),
        publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
        profiles: { 'text-publication-v1': profileRegistry['text-publication-v1'].sha256 } };
    }
    override async query(query: string): Promise<SparqlResult> {
      if (query.includes('ASK') && query.includes('?basisLink')) {
        probes++;
        expect(query).toContain(`BIND(<${work}> AS ?basisTarget)`);
        expect(query).toContain('rv:Post');
        expect(query).toContain('rv:ChapterRole');
        expect(query).toContain(`<${author}>`);
        return { boolean: true };
      }
      if (query.includes('SELECT ?work ?author ?language ?head')) return { results: { bindings: [{
        work: uri(work), author: uri(author), language: literal('zh'), head: uri(head),
      }] } };
      if (query.includes('SELECT ?component ?manifest')) return { results: { bindings: [{
        component: uri(contribution), manifest: uri(`urn:rezics:sha256:${manifest}`),
        model: uri(CONTRIBUTION_PROFILE), shape: uri(CONTRIBUTION_PROFILE),
        dataset: uri(DATASET), epoch: literal('epoch'), sequence: literal('1'),
      }] } };
      if (query.includes('ASK') && query.includes('a rv:TextContribution')) return { boolean: true };
      if (query.includes('SELECT ?receipt')) return { results: { bindings: [{
        receipt: uri(textContributionReceiptIri(basisAdmission)),
      }] } };
      if (query.includes('SELECT ?p ?o')) {
        const digest = textContributionDigest({ work, language: 'zh', actingSubject: author, body: '译文正文' });
        const rv = 'https://rezics.com/vocab/';
        const terms: Record<string, { type: string; value: string; datatype?: string }> = {
          'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': uri(`${rv}OperationReceipt`),
          [`${rv}operation`]: uri(author),
          [`${rv}requestDigest`]: plain(digest),
          [`${rv}admissionId`]: plain(basisAdmission),
          [`${rv}authorityEpoch`]: plain('0'),
          [`${rv}admittedScope`]: plain(`contribution:create:${work}`),
          [`${rv}outcome`]: uri(`${rv}Succeeded`),
          [`${rv}work`]: uri(work),
          [`${rv}contribution`]: uri(contribution),
          [`${rv}draftRevision`]: uri(head),
          [`${rv}language`]: plain('zh'),
          [`${rv}author`]: uri(author),
          [`${rv}datasetId`]: uri(DATASET),
          [`${rv}dataEpoch`]: plain('epoch'),
          [`${rv}sequence`]: integer('1'),
        };
        return { results: { bindings: Object.entries(terms).map(([predicate, object]) => ({
          p: uri(predicate), o: object })) } };
      }
      return { boolean: false, results: { bindings: [] } };
    }
    override async commandWithReceipt(): Promise<never> {
      commands++;
      throw new Error('Unexpected publication write');
    }
  }
  try {
    const env: WorkActivationEnvironment = { fuseki: new TranslationGraph('http://localhost:1/rezics'),
      lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, objectDirectory: directory };
    const input = { contribution, expectedDraftHead: head, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const, actingSubject: author };
    await expect(publishTextContribution(env, { id: randomUUID(), scope: `contribution:publish:${contribution}`,
      action: 'contribution.publish', actingSubject: author, requestDigest: textPublicationDigest(input),
      authorityEpoch: '0', idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      principalId: randomUUID(), state: 'claimed', dispatchEligible: true, replayed: false }, input))
      .rejects.toBeInstanceOf(TranslationBasisRequired);
    expect(probes).toBe(1);
    expect(commands).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
