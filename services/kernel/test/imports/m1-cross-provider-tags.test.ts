import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { vndbPublicTagConceptUri, vndbPublicTagScheme } from '../../../../packages/conversion/src/support.ts';
import { showcaseTagParentCommand } from '../../../importer/src/showcase-cross-provider-tags.ts';
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
    const proposal = showcaseTagParentCommand(binding);
    expect(proposal.rights).toMatchObject({ license: 'ODbL-1.0' });
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
  } finally {
    await runtime.close();
  }
}, 180_000);
