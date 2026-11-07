import type { ContentCoverObligation } from './domain-ports.ts';

/** Disclosed Subject summary vocabulary. HTTP schemas and native readers share these values. */

export type CoverCredit = {
  rightsHolder: string;
  via: { name: string; url: string };
  license: string;
  obligations: ContentCoverObligation[];
};

export type CoverSummary = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: { x: number; y: number } | null;
  credit: CoverCredit;
};

export type SubjectSummary = {
  id: string;
  type: string;
  types: string[];
  label: { value: string; language: string } | null;
  creativeWork: boolean;
  cover: CoverSummary | null;
};

/** A merged original keeps its id; its summary is the survivor's and `redirect` names that survivor. */
export type RelatedSubjectSummary = SubjectSummary & { redirect?: string };

export type PublicSummaryQuery = Readonly<{
  ids: readonly string[];
  languages: readonly string[];
  deadline: number;
}>;

export type PublicSummaryRead<Summary extends SubjectSummary = SubjectSummary> = (
  query: PublicSummaryQuery,
) => Promise<ReadonlyMap<string, Summary>>;
