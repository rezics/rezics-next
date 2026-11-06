import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '@rezics/conversion/vndb-vocabulary';
import {
  emptyCrossMediaPlan,
  crossMediaAliases,
  type CrossMediaSeedResult,
} from '../../../importer/src/cross-media-seed.ts';
import { prepareShowcaseTagParentPublications } from '../../../importer/src/showcase-tags.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  showcaseTagParentCommand,
  showcaseTagParentMetadata,
} from '../../../importer/src/showcase-cross-provider-tags.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const context = GLOBAL_CONTEXT;

async function acceptAndAdopt(
  editor: Awaited<ReturnType<typeof openApiObserver>>,
  subjectId: string,
  property: string,
): Promise<void> {
  const seen = new Set<string>();
  for (;;) {
    const response = await editor.http(
      `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
    );
    expect(response.status).toBe(200);
    const page = response.body as {
      candidates: { id: string; head: number | null; retracted: number | null; decision?: string | null }[];
      adoption: { head: number } | null;
    };
    const next = page.candidates.find((candidate) => !candidate.retracted && !seen.has(candidate.id));
    if (next) {
      const accepted = await editor.http(`/v1/subjects/${subjectId}/candidates/${next.id}:accept`, {
        context,
        expected_head: next.head,
      });
      expect(accepted.status).toBe(200);
      seen.add(next.id);
      continue;
    }
    const adopted = await editor.http(`/v1/subjects/${subjectId}:adopt`, {
      context,
      property,
      mode: 'replace',
      expected_head: page.adoption?.head ?? null,
      selection: page.candidates
        .filter((candidate) => !candidate.retracted && candidate.decision === 'accept')
        .map((candidate) => ({ candidate: candidate.id, rank: 'normal' as const })),
    });
    expect(adopted.status).toBe(200);
    return;
  }
}

test('exact VNDB parent assertions need separate native acceptance and adoption before a public broader read', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: randomUUID(), tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: context },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const authored = {
      source: 'm1-cross-provider-tags',
      record_revision: 'unversioned',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'facts' as const,
    };
    const create = async (key: string, type: string): Promise<string> => {
      const response = await runtime.importTransport.batch({
        commands: [
          {
            op: 'create',
            key,
            source: { ...authored, external_id: key },
            subject: { type, labels: { en: key } },
          },
        ],
      });
      expect(response.results[0]?.status).toBe(201);
      return (response.results[0] as { value: { id: string } }).value.id;
    };
    const schemeId = await create('scheme-cont', 'skos:ConceptScheme');
    const childId = await create('tag-g311', 'skos:Concept');
    const parentId = await create('tag-g12', 'skos:Concept');
    const schemeUri = vndbPublicTagScheme('cont');
    const childUri = vndbPublicTagConceptUri('cont', 'g311');
    const parentUri = vndbPublicTagConceptUri('cont', 'g12');
    const cite = (uri: string) => [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: uri } }] },
    ];
    const proposeBindings = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: 'scheme-uri',
          source: { ...authored, external_id: 'scheme-cont' },
          subject: schemeId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: schemeUri },
            references: cite(schemeUri),
          },
        },
        ...(
          [
            [childId, childUri],
            [parentId, parentUri],
          ] as const
        ).flatMap(([subject, uri]) => [
          {
            op: 'propose' as const,
            key: `concept-uri-${subject}`,
            source: { ...authored, external_id: `concept-${subject}` },
            subject,
            statement: {
              property: { id: 'schema:url' },
              value: { type: 'value' as const, content: uri },
              references: cite(uri),
            },
          },
          {
            op: 'propose' as const,
            key: `concept-scheme-${subject}`,
            source: { ...authored, external_id: `concept-${subject}` },
            subject,
            statement: {
              property: { id: 'skos:inScheme' },
              value: { type: 'value' as const, content: schemeId },
              references: cite(uri),
            },
          },
        ]),
      ],
    });
    expect(proposeBindings.results.every((result) => result.status === 201)).toBe(true);
    await acceptAndAdopt(editor, schemeId, 'schema:url');
    for (const id of [childId, parentId]) {
      await acceptAndAdopt(editor, id, 'schema:url');
      await acceptAndAdopt(editor, id, 'skos:inScheme');
    }

    const binding = {
      child: 'g311',
      parent: 'g12',
      main: true,
      category: 'cont' as const,
      path: '/tags_parents/g311/g12',
      childId,
      parentId,
      schemeId,
      childUri,
      parentUri,
      schemeUri,
      releaseDigest: bundledDigest,
    };
    const corrected = showcaseTagParentCommand(binding);
    const proposal = {
      ...corrected,
      key: 'sealed-parent-v1',
      source: { ...corrected.source, converter_revision: 'vndb-public-tag-vocabulary@1' },
      statement: { ...corrected.statement, references: [{ parts: corrected.statement.references[0]!.parts.slice(1) }] },
    };
    expect(proposal.rights).toBeUndefined();
    await runtime.importTransport.setSourceRecordMetadata({
      command: showcaseTagParentMetadata(binding),
      idempotencyKey: randomUUID(),
    });
    expect(proposal.statement.property.id).toBe('skos:broader');
    expect(proposal.statement.qualifiers).toBeUndefined();
    const sent = await runtime.importTransport.batch({ commands: [proposal] });
    expect(sent.results[0]?.status).toBe(201);
    const before = await editor.http(`/v1/subjects/${childId}?context=${context}`);
    expect(before.status).toBe(200);
    const readBefore = before.body as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    expect(readBefore.subject.statements['skos:broader'] ?? []).toEqual([]);

    await acceptAndAdopt(editor, childId, 'skos:broader');
    const after = await editor.http(`/v1/subjects/${childId}?context=${context}`);
    expect(after.status).toBe(200);
    const readAfter = after.body as { subject: { statements: Record<string, { value: { content: unknown } }[]> } };
    expect(readAfter.subject.statements['skos:broader']?.map((statement) => statement.value.content)).toEqual([
      parentId,
    ]);
    expect(JSON.stringify(after.body.subject)).toContain('ODbL-1.0');

    const journal = new ShowcaseJournal(':memory:');
    journal.prepareCommand(proposal);
    const oldReceipt = sent.results[0]!;
    if ('problem' in oldReceipt) throw new Error('Expected native parent receipt');
    journal.acknowledgeCommand(proposal, oldReceipt);
    const oldBytes = JSON.stringify(journal.acknowledgedCommands()[0]!.command);
    const publicationPort = captureShowcaseCommands(runtime.importTransport, journal);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(String(input));
          return runtime.request(`${url.pathname}${url.search}`);
        },
        { preconnect: fetch.preconnect },
      ),
    });
    const plan = emptyCrossMediaPlan();
    const result: CrossMediaSeedResult = {
      status: 'imported',
      franchises: plan.franchises,
      members: [],
      runs: {},
      readings: [],
      personIdentities: [],
      mediaOutcomes: [],
      workLinks: [],
      gaps: [],
      creditGaps: [],
      vndbCreditDiagnostics: [],
      vndbCreditVocabularyRequirements: [],
      vndbCreditVocabularyUnavailable: [],
      vndbCharacterProfileRequirements: [],
      vndbCharacterProfileOmissions: [],
      characterDiagnostics: [],
      episodeDiagnostics: [],
      unresolved: [],
      vndbWorkRelations: [],
    };
    const refresh = {
      category: binding.category,
      tagId: binding.child,
      childId,
      schemeId,
      childUri,
      schemeUri,
      releaseDigest: bundledDigest,
    };
    const publish = async (edges: (typeof binding)[], refreshParents = true) => {
      const prepared = await prepareShowcaseTagParentPublications({
        evidence: edges,
        port: publicationPort,
        journal,
      });
      expect(prepared.gaps).toEqual([]);
      return publishShowcase({
        plan,
        result,
        aliases: crossMediaAliases,
        journal,
        review: runtime.importTransport,
        publicClient,
        tagParentEvidence: edges,
        tagParentAcknowledgements: prepared.acknowledgements,
        tagParentRefreshes: refreshParents ? [refresh] : [],
      });
    };
    try {
      // Reopening the current proposal is idempotent even after independent manual adoption.
      const reopened = await publish([binding]);
      expect(reopened.manifest.tagParentPublications).toMatchObject([{ status: 'public', parentId }]);
      const correctedRead = await publicClient.readSubject(childId);
      expect(JSON.stringify(correctedRead.subject)).toContain('https://vndb.org/g311#/tags_parents/g311/g12');
      expect(JSON.stringify(correctedRead.subject)).toContain('ODbL-1.0');
      expect(
        JSON.stringify(journal.acknowledgedCommands().find((row) => row.command.key === proposal.key)!.command),
      ).toBe(oldBytes);
      const firstIds = journal.acknowledgedCommands().map((row) => row.candidateId);
      await publish([binding]);
      expect(journal.acknowledgedCommands().map((row) => row.candidateId)).toEqual(firstIds);

      const editorial = await editor.http(`/v1/subjects/${childId}/candidates`, {
        statement: { property: { id: 'skos:broader' }, value: { type: 'value', content: parentId } },
      });
      expect(editorial.status).toBe(201);
      await acceptAndAdopt(editor, childId, 'skos:broader');

      // The same source parent now resolves to another independently reviewed native identity.
      const replacementId = await create('replacement-g12', 'skos:Concept');
      const replacementFacts = await runtime.importTransport.batch({
        commands: [
          { property: 'schema:url', content: parentUri },
          { property: 'skos:inScheme', content: schemeId },
        ].map(({ property, content }) => ({
          op: 'propose' as const,
          key: randomUUID(),
          source: { ...authored, external_id: 'replacement-g12' },
          subject: replacementId,
          statement: {
            property: { id: property },
            value: { type: 'value' as const, content },
            references: cite(parentUri),
          },
        })),
      });
      expect(replacementFacts.results.every((entry) => entry.status === 201)).toBe(true);
      await acceptAndAdopt(editor, replacementId, 'schema:url');
      await acceptAndAdopt(editor, replacementId, 'skos:inScheme');
      const changed = { ...binding, parentId: replacementId };
      const replaced = await publish([changed]);
      expect(replaced.manifest.tagParentPublications).toMatchObject([{ status: 'public', parentId: replacementId }]);
      const current = await publicClient.readSubject(childId);
      const broader = (current.subject as typeof readAfter.subject).statements['skos:broader']!;
      expect(broader.map((row) => row.value.content).sort()).toEqual([parentId, replacementId].sort());

      // A complete empty inventory retires only managed assertions and keeps the editorial selection.
      await publish([]);
      const retired = await publicClient.readSubject(childId);
      expect(
        (retired.subject as typeof readAfter.subject).statements['skos:broader']?.map((row) => row.value.content),
      ).toEqual([parentId]);
      await publish([changed]);
      const beforeFence = await editor.http(
        `/v1/subjects/${childId}/candidates?${new URLSearchParams({ property: 'skos:broader', context })}`,
      );
      const fence = await editor.http('/v1/sourceFences:takedown', {
        source: crossMediaAliases.vndb,
        externalId: binding.path,
        fieldGroup: 'facts',
        reason: 'Source withdrawal',
      });
      expect(fence.status).toBe(200);
      await publish([]);
      const afterFence = await editor.http(
        `/v1/subjects/${childId}/candidates?${new URLSearchParams({ property: 'skos:broader', context })}`,
      );
      expect(afterFence.body.adoption).toEqual(beforeFence.body.adoption);
    } finally {
      journal.close();
    }
  } finally {
    await runtime.close();
  }
}, 180_000);

test('shared reviewed-tag setup delegates Global review grants through the current governor', async () => {
  const driver = await createSemanticDriver();
  try {
    await driver.grant('acceptor', ['context:accept', 'context:adopt'], GLOBAL_CONTEXT);
    await driver.grant('editor', ['statement:propose'], GLOBAL_CONTEXT);
  } finally {
    await driver.close();
  }
}, 180_000);
