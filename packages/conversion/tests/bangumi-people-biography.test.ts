import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { convertCrossMediaEntity, converter_revision } from '../src/cross-media-entities.ts';

const source = 'bangumi_cross_media';
const subjectId = '11111111-1111-4111-8111-111111111111';
const biography = '作者简介：星見は物語と音楽を長く研究している。';

function convert(summary?: string, type = 1, bound = true) {
  const record: Record<string, unknown> = {
    id: 8101,
    type,
    name: '星見',
    description: 'Foreign-source description without an admitted Bangumi licence.',
    ...(summary === undefined ? {} : { summary }),
  };
  return convertCrossMediaEntity(
    { external_id: 'person:8101', record_revision: null, record },
    { source, ...(bound ? { subjectId } : {}) },
    { sourceKind: 'bangumi' },
  );
}

function summary(result: ReturnType<typeof convert>) {
  return result.proposals.find((command) => command.source.field_group === 'summary');
}

function content(command: Extract<BatchCommand, { op: 'propose' }>) {
  const value = command.statement.value;
  if (value.type !== 'value') throw new Error('Expected a literal biography value');
  return value.content;
}

test('authored Bangumi person summaries preserve profile, document rights and refresh digest', () => {
  const person = convert(biography);
  const proposal = summary(person);
  expect(converter_revision).toBe('cross-media-entities@8');
  expect(person.normalizedRecord.summary).toBe(biography);
  expect(person.normalizedRecord).not.toHaveProperty('description');
  expect(proposal?.op).toBe('propose');
  if (!proposal || proposal.op !== 'propose') throw new Error('Missing biography proposal');
  expect(proposal.source).toMatchObject({
    source,
    external_id: 'person:8101',
    record_revision: 'unversioned',
    converter_revision,
    digest: person.digest,
    field_group: 'summary',
  });
  expect(proposal.statement.property.id).toBe('schema:abstract');
  expect(proposal.statement.references?.[0]?.parts).toContainEqual({
    property: { id: 'schema:url' },
    value: { type: 'value', content: 'https://bgm.tv/person/8101' },
  });
  expect(proposal.rights).toEqual({
    license: 'CC-BY-SA-3.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
    attribution: 'Bangumi contributors (https://bgm.tv/person/8101)',
  });
  const biographyContent = content(proposal) as {
    language: string;
    document: { doc: { content: { type: string; content?: { type: string; text: string }[] }[] } };
  };
  expect(biographyContent.language).toBe('und');
  expect(biographyContent.document.doc.content[0]?.content?.[0]?.text).toBe(biography);
  const literal = convert('<script>alert(1)</script> **source prose**');
  const literalProposal = summary(literal);
  if (!literalProposal || literalProposal.op !== 'propose') throw new Error('Missing literal biography proposal');
  const literalDocument = content(literalProposal) as typeof biographyContent;
  expect(literalDocument.document.doc.content[0]?.type).toBe('paragraph');
  expect(literalDocument.document.doc.content[0]?.content?.[0]?.type).toBe('text');
  expect(literalDocument.document.doc.content[0]?.content?.[0]?.text).toBe(
    '<script>alert(1)</script> **source prose**',
  );
  expect(checkBatchWrite({ commands: [proposal] }, bundledRelease)).toEqual([]);

  const personBootstrap = convert(biography, 1, false).proposals[0];
  expect(personBootstrap?.op === 'create' ? personBootstrap.subject.type : undefined).toBe('schema:Person');
  const organizationBootstrap = convert(biography, 2, false).proposals[0];
  expect(organizationBootstrap?.op).toBe('create');
  if (organizationBootstrap?.op !== 'create') throw new Error('Missing organization identity');
  expect(organizationBootstrap.subject.type).toBe('schema:Organization');
  const organizationBiography = summary(convert(biography, 2));
  expect(organizationBiography?.op).toBe('propose');
  if (!organizationBiography || organizationBiography.op !== 'propose')
    throw new Error('Missing organization biography proposal');
  expect(checkBatchWrite({ commands: [organizationBiography] }, bundledRelease)).toEqual([]);
  const identifier = person.proposals.find(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'wdt:P6298',
  );
  expect(identifier?.op === 'propose' ? content(identifier) : undefined).toBe('8101');
  expect(person.proposals.some((command) => command.op === 'propose' && command.source.field_group === 'facts')).toBe(
    true,
  );
  expect(
    person.proposals
      .filter((command) => command.source.field_group === 'facts')
      .every((command) => !('rights' in command)),
  ).toBe(true);

  const changed = convert('新しい伝記。');
  expect(changed.digest).not.toBe(person.digest);
  expect(summary(changed)?.key).not.toBe(proposal.key);
  for (const empty of [convert(), convert('')])
    expect(empty.proposals.some((command) => command.source.field_group === 'summary')).toBe(false);

  const historical = {
    ...bundledRelease,
    properties: Object.fromEntries(
      Object.entries(bundledRelease.properties).filter(([id]) => id !== 'schema:abstract'),
    ),
  };
  const facts = person.proposals.filter((command) => command.source.field_group === 'facts');
  expect(checkBatchWrite({ commands: facts }, historical)).toEqual([]);
  expect(checkBatchWrite({ commands: [proposal] }, historical).length).toBeGreaterThan(0);
  expect(() => convert('x'.repeat(32_769))).toThrow();
  expect(() => convert('語'.repeat(11_000))).toThrow();
  expect(() => convert('\ud800')).toThrow();
});
