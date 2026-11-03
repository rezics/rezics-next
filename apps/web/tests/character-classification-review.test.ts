import { expect, test } from 'bun:test';
import {
  classificationAdmitted,
  classificationBaselineKind,
  classificationConfirmable,
  classificationReuseReason,
  focusableClassificationHolder,
  retainOrphanedClassificationDiagnostic,
  selectedClassificationTarget,
  sameSealedClassification,
} from '../src/features/catalogue/character-classification-review';
import { applyReuse, cloneReferenceGroup } from '../src/features/catalogue/reference-reuse';
import { statementInput } from '../src/features/catalogue/statement-editor';
import { factHolder, type FactDraft, type FactsCurrent } from '../src/features/catalogue/subject-facts';
import { characterProfileFixture } from '../src/kernel/fake/catalogue-character-profile';

const concept = '00000000-0000-4000-8000-00000000d101';
const replacement = '00000000-0000-4000-8000-00000000d102';

function draft(read: FactsCurrent, property: string): FactDraft {
  const selected = read.public.subject.statements[property]![0]!;
  const baseline = statementInput(selected);
  return {
    holder: crypto.randomUUID(),
    property,
    source: selected.id,
    baseline,
    included: true,
    statement: structuredClone(baseline),
  };
}

function current(): FactsCurrent {
  const fixture = characterProfileFixture();
  const read: FactsCurrent = {
    ok: true,
    public: fixture.character,
    release: structuredClone(fixture.release),
    source: null,
  };
  const seed = read.public.subject.statements['schema:height']![0]!;
  for (const [field, id] of [
    ['schema:keywords', concept],
    ['schema:gender', replacement],
  ] as const) {
    read.public.subject.statements[field] = [
      {
        ...structuredClone(seed),
        id: `00000000-0000-4000-8000-${field === 'schema:keywords' ? '000000008001' : '000000008002'}`,
        property: { id: field, data_type: 'wikibase-item' },
        value: { type: 'value', content: id },
        references: [
          {
            hash: 'review',
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'https://archive.example/evidence' },
              },
            ],
          },
        ],
      },
    ];
  }
  read.public.related[concept] = { type: 'skos:Concept', labels: { ja: '出典で明示された分類' } };
  read.public.related[replacement] = { type: 'skos:Concept', labels: { en: 'Another supplied classification' } };
  return read;
}

test('selected classification identity uses current related labels, never a missing map entry', () => {
  const read = current();
  const [keywords] = read.public.subject.statements['schema:keywords']!;
  const shown = selectedClassificationTarget(keywords!, read.public.related, 'en');
  expect(shown).toMatchObject({ id: concept, state: 'available', lang: 'ja', label: '出典で明示された分類' });
  delete read.public.related[concept];
  expect(selectedClassificationTarget(keywords!, read.public.related, 'en').state).toBe('hidden');
});

test('reuse copies only reference parts onto an admitted sibling and leaves locked or retired holders', () => {
  const read = current();
  const keywords = draft(read, 'schema:keywords');
  const gender = draft(read, 'schema:gender');
  const group = cloneReferenceGroup(keywords.statement.references[0]!);
  keywords.statement.references[0] = group;
  gender.statement.value = { type: 'value', content: concept };
  const copied = applyReuse(
    [keywords, gender],
    { holder: factHolder(keywords), property: keywords.property, groupIndex: 0, snapshot: structuredClone(group) },
    [factHolder(gender)],
    read.release,
  );
  expect(copied.applied).toEqual([{ holder: factHolder(gender), property: 'schema:gender', index: 1 }]);
  expect(copied.drafts[1]!.statement.value).toEqual({ type: 'value', content: concept });
  expect(copied.drafts[1]!.statement.references[1]).toEqual(group);
  expect(copied.drafts[1]!.statement.references[1]).not.toBe(copied.drafts[0]!.statement.references[0]);
  copied.drafts[1]!.statement.references[1]!.parts[0]!.value = { type: 'value', content: 'https://other.example' };
  expect(copied.drafts[0]!.statement.references[0]!.parts[0]!.value).toEqual({
    type: 'value',
    content: 'https://archive.example/evidence',
  });
  const succeeded: FactDraft = {
    ...gender,
    result: { ok: true, kind: 'proposed-awaiting-review', candidate: 'c1', revision: 2 },
  };
  expect(classificationReuseReason(succeeded, group, read.release, factHolder(keywords), true)).toBe('succeeded');
  expect(classificationReuseReason(gender, group, read.release, factHolder(keywords), false)).toBe('retired');
  expect(classificationAdmitted(read, 'schema:keywords')).toBe(true);
});

test('confirm waits for a current review, blocks unread or withdrawn new intent, and keeps removed-holder diagnostics unfocusable', () => {
  const read = current();
  const keywords = draft(read, 'schema:keywords');
  keywords.statement.value = { type: 'value', content: replacement };
  expect(
    classificationConfirmable({
      drafts: [keywords],
      reviewCurrent: false,
      admitted: new Set(['schema:keywords']),
      readFailed: false,
    }),
  ).toBe(false);
  expect(
    classificationConfirmable({
      drafts: [keywords],
      reviewCurrent: true,
      admitted: new Set(['schema:keywords']),
      readFailed: true,
    }),
  ).toBe(false);
  expect(
    classificationConfirmable({
      drafts: [keywords],
      reviewCurrent: true,
      admitted: new Set(),
      readFailed: false,
    }),
  ).toBe(false);
  const sealed = {
    ...keywords,
    command: { id: read.public.subject.id, key: 'same-key', statement: keywords.statement },
    result: { ok: false as const, reason: 'uncertain' as const },
  };
  expect(
    classificationConfirmable({
      drafts: [sealed],
      reviewCurrent: false,
      admitted: new Set(),
      readFailed: true,
    }),
  ).toBe(true);
  expect(sameSealedClassification(sealed, { ...sealed, statement: { ...sealed.statement } })).toBe(true);
  const invalid = {
    ...keywords,
    result: { ok: false as const, reason: 'invalid' as const, errors: [{ pointer: '/statement/value', code: 'required' }] },
  };
  const orphans = retainOrphanedClassificationDiagnostic(invalid, []);
  expect(focusableClassificationHolder(factHolder(invalid), [], orphans)).toBeNull();
  expect(classificationBaselineKind({ source: 'gone', baseline: keywords.baseline }, read, 'schema:keywords')).toBe(
    'withdrawn',
  );
  expect(classificationBaselineKind({ source: null, baseline: null }, read, 'schema:keywords')).toBe('absent');
});
