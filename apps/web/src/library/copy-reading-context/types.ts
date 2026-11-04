export type CopyReadingIdentity = {
  id: string;
  label: string;
  labelLanguage?: string;
};

export type CopyReadingFact = {
  label: string;
  value?: string;
  subject?: CopyReadingIdentity;
};

/** A page projection of admitted catalogue meaning, separate from every copy's private fields and revision. */
export type CopyReadingContext = {
  association: 'available' | 'unavailable';
  work: CopyReadingIdentity[];
  edition?: CopyReadingIdentity;
  facts: CopyReadingFact[];
};

export type CopyReadingContexts = Record<string, CopyReadingContext>;
