import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import type { ShowcaseManifest } from './showcase-contract.ts';
import type { VndbWorkRelationOutcome } from './cross-media-seed.ts';

export const showcaseAdoptInvocationBound = 32;

export type ShowcaseAdoptBody = {
  context: string;
  property: string;
  mode: 'replace';
  expected_head: number | null;
  selection: { candidate: string; rank: 'normal' | 'preferred' }[];
};

export type ShowcasePublicationResult = Readonly<{
  status: 'published' | 'incomplete';
  manifest: ShowcaseManifest;
  published: readonly {
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    readerRoute: string;
    assertions: readonly {
      candidateId: string;
      property: string;
      digest: string;
      citations?: readonly string[];
      qualifiers?: NonNullable<BatchStatement['qualifiers']>;
      rights?: Extract<BatchCommand, { op: 'propose' }>['rights'];
      target?: { sourceKey: string; subjectId: string; nativeType: string };
      adoption: { head: number; candidateId: string; rank: 'normal' | 'preferred' | 'deprecated' };
      readback: unknown;
    }[];
  }[];
  vndbWorkRelations: readonly VndbWorkRelationOutcome[];
  omissions: readonly { provider: 'bangumi' | 'vndb'; sourceKey: string; code: string }[];
  unresolvedCharacterDependencies: readonly {
    workKey: string | null;
    workSubjectId: string | null;
    characterKey: string;
    characterSubjectId: string | null;
    sourceIndex: number | null;
    conceptUri?: string;
    conceptId?: string;
    code?: string;
    reason: string;
    property?: string;
  }[];
}>;
