export type WikiProblemCode = 'invalid_wiki_extraction' | 'invalid_wiki_candidates' | 'invalid_language'
  | 'wiki_unavailable' | 'wiki_target_mismatch' | 'wiki_continuity_mismatch' | 'wiki_unaligned_unit'
  | 'wiki_occurrence_mismatch' | 'wiki_entity_type' | 'wiki_match_type' | 'wiki_reference'
  | 'wiki_predicate' | 'wiki_locator_source' | 'wiki_quote_mismatch' | 'wiki_passage_limit'
  | 'wiki_work_quotation_budget' | 'wiki_query_budget' | 'wiki_quotation_unavailable';
export class WikiRejected extends Error {
  constructor(readonly code: WikiProblemCode, readonly status: 400 | 404 | 422 | 503 = 422) {
    super(code);
  }
}
