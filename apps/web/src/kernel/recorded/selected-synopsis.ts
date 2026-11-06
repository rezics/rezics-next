import type { SubjectRead } from '@rezics/client';
import recording from './subject.json';

/** Recorded native selected-slot citation. Document operands never appear here. */
export const RECORDED_SELECTED_SYNOPSIS_CITATION = 'https://catalogue.example.test/little-prince-synopsis';
export const RECORDED_SELECTED_SYNOPSIS_DOCUMENT = '0494501a-36af-8cc7-95c9-d7ffe4728301';
export const RECORDED_SELECTED_SYNOPSIS_DIGEST = 'a4f0c3b8e1d9726f5a0c8d4e7b1f36590c2a8e6d4b7f1c3059e8a2d6b4c1f708';
export const RECORDED_SELECTED_SYNOPSIS_LANGUAGE = 'en';

type Matched = Extract<NonNullable<SubjectRead['selectedSynopsis']>, { kind: 'matched' }>;
type SelectedFact = Matched['fact'];

const subject = structuredClone(recording.subject) as SubjectRead['subject'];

export const recordedSelectedSynopsisSelection = {
  candidateId: '0494501a-36af-8cc7-95c9-d7ffe4728201',
  documentId: RECORDED_SELECTED_SYNOPSIS_DOCUMENT,
  digest: RECORDED_SELECTED_SYNOPSIS_DIGEST,
  language: RECORDED_SELECTED_SYNOPSIS_LANGUAGE,
  locale: 'en',
  context: subject.context,
  subjectRelease: subject.release,
} as const;

const citation = {
  hash: 'recorded-selected-synopsis-support',
  parts: [
    {
      property: { id: 'schema:url', data_type: 'url' as const },
      value: { type: 'value' as const, content: RECORDED_SELECTED_SYNOPSIS_CITATION },
    },
  ],
};

/** Closed native matched fact: locators stay somevalue; citations stay exact. */
export const recordedSelectedSynopsisFact: SelectedFact = {
  id: recordedSelectedSynopsisSelection.candidateId,
  rank: 'normal',
  property: { id: 'schema:abstract', data_type: 'document' },
  value: { type: 'somevalue' },
  qualifiers: [],
  references: [citation],
};

export const recordedSelectedSynopsisMatched: Matched = {
  kind: 'matched',
  context: subject.context,
  release: subject.release,
  fact: recordedSelectedSynopsisFact,
};

export const recordedCurrentSynopsisStatement = {
  ...recordedSelectedSynopsisFact,
  value: {
    type: 'value' as const,
    content: {
      document: RECORDED_SELECTED_SYNOPSIS_DOCUMENT,
      digest: RECORDED_SELECTED_SYNOPSIS_DIGEST,
      language: RECORDED_SELECTED_SYNOPSIS_LANGUAGE,
    },
  },
  rezics: { release: subject.release, revision: 1 },
};

export type RecordedSelectedSynopsisKind =
  | 'matched'
  | 'matched-empty'
  | 'changed'
  | 'missing'
  | 'unavailable'
  | 'empty';

function closedSelectedSynopsis(kind: 'changed' | 'missing' | 'unavailable'): { kind: typeof kind } {
  return { kind };
}

/** Native Subject GET body used by Sources and authored comparison. Page DTOs with inline documents are not this recording. */
export function recordedSelectedSynopsisRead(kind: RecordedSelectedSynopsisKind = 'matched'): SubjectRead {
  const read = structuredClone(recording) as unknown as SubjectRead;
  if (kind === 'empty') {
    delete read.selectedSynopsis;
    read.subject.statements['schema:abstract'] = [];
    return read;
  }
  const statement = structuredClone(recordedCurrentSynopsisStatement);
  const matched = structuredClone(recordedSelectedSynopsisMatched);
  if (kind === 'matched-empty') {
    statement.references = [];
    matched.fact.references = [];
  }
  read.subject.statements['schema:abstract'] = [statement];
  read.selectedSynopsis =
    kind === 'matched' || kind === 'matched-empty' ? matched : closedSelectedSynopsis(kind);
  return read;
}
