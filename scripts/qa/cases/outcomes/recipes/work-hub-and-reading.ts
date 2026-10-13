import { pending, rowOutcomes } from '../../outcome-cells.ts';

// Proposed minimum contracts for manager acceptance, not implemented operations.
// Unknown evidence proves retention only, never publication eligibility.
export const sourcedRecipePrerequisites = {
  intake: 'POST /v1/sources/intakes must retain rightsEvidence.basis=public-domain without relabeling it as facts/original/exception',
  publication: 'POST /v1/work-publications needs a public-domain alternative bound to sourceObservation and its exact supported Structure revision',
  authority: 'Intake needs catalogue-import exposure and platform:resource:work.create at work:create:root; publication needs platform:resource:work.publish at work:publish:{work}. Bootstrap has no work.publish assignment ceiling: public grant issuance must be provisioned before operation proof',
  structure: 'POST /v1/recipes/{structure}/imports binds exact source lines but currently inserts every imported section at the root; preserve retained HowToSection parents using existing Structure changes',
  delivery: 'GET /v1/works/{work} needs rights={basis,source:{record,observation,provider,externalId,url}} for the selected publication; GET credits needs retained source author and importing actor as transcriber',
  credit: 'Source author adoption is Open Library-only; native/public credit roles omit transcriber. Generalize existing Source/Work credits, derive author from retained evidence, preserve explicit unknown authorship',
} as const;

export default rowOutcomes('recipes/work-hub-and-reading', {
  visitor: pending('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  stranger: pending('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  member: pending('reads published recipe text and structure without membership overriding source credit or private boundaries'),
  owner: pending('reads published recipe text and structure with the importer credited as transcriber rather than original author'),
  moderator: pending('reads published recipe text and structure without moderation overriding source credit or private boundaries'),
  operator: pending('publishes and reads source-marked public-domain text and structure under the corresponding platform mandate'),
}, { rights: { basis: 'public-domain', credit: 'Bounded pinned extract from Project Gutenberg 65061, The Boston Cooking-School Cook Book (1910), Fannie Merritt Farmer, https://www.gutenberg.org/ebooks/65061; importer must be transcriber, never source author. This is no corpus-clearance claim.' } });
