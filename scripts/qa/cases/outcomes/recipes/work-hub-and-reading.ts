import { sourcedPublicationAuthority } from '../../identity-and-access.ts';
import { sourcedPublicationDelivery } from '../../content-composition.ts';
import { proved, rowOutcomes } from '../../outcome-cells.ts';

// The source-bound publication contract, exercised through public Main operations.
// Unknown evidence proves retention only, never publication eligibility.
export const sourcedRecipePrerequisites = {
  intake: 'POST /v1/sources/intakes must retain rightsEvidence.basis=public-domain without relabeling it as facts/original/exception',
  publication: 'POST /v1/work-publications needs a public-domain alternative bound to sourceObservation and its exact supported Structure revision',
  ...sourcedPublicationAuthority,
  structure: 'POST /v1/recipes/{structure}/imports binds exact source lines but currently inserts every imported section at the root; preserve retained HowToSection parents using existing Structure changes',
  ...sourcedPublicationDelivery,
  credit: 'Selected sourced-publication credits include the retained source author and importing actor as transcriber, preserving explicit unknown authorship; external author adoption remains independently owned',
} as const;

export default rowOutcomes('recipes/work-hub-and-reading', {
  visitor: proved('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  stranger: proved('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  member: proved('reads published recipe text and structure without membership overriding source credit or private boundaries'),
  owner: proved('reads published recipe text and structure with the importer credited as transcriber rather than original author'),
  moderator: proved('reads published recipe text and structure without moderation overriding source credit or private boundaries'),
  operator: proved('publishes and reads source-marked public-domain text and structure under the corresponding platform mandate'),
}, { rights: { basis: 'public-domain', credit: 'Bounded pinned extract from Project Gutenberg 65061, The Boston Cooking-School Cook Book (1910), Fannie Merritt Farmer, https://www.gutenberg.org/ebooks/65061; importer must be transcriber, never source author. This is no corpus-clearance claim.' } });
