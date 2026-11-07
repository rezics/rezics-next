export type ConceptWorksRouteState = {
  role?: string | undefined;
  returnTo?: string | undefined;
  property?: string | undefined;
  scheme?: string | undefined;
  type?: string | undefined;
  sort?: 'name' | 'rating' | undefined;
  includeChildren?: boolean | undefined;
  spoilerThreshold?: 0 | 1 | 2 | undefined;
  conditionText?: string | undefined;
  tagQualifiersText?: string | undefined;
  cursor?: string | undefined;
  invalid?: boolean | undefined;
};
