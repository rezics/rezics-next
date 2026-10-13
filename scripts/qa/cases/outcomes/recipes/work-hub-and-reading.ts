import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/work-hub-and-reading', {
  visitor: pending('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  stranger: pending('reads published recipe text and structure with truthful linked public-domain source and source-author credit'),
  member: pending('reads published recipe text and structure without membership overriding source credit or private boundaries'),
  owner: pending('reads published recipe text and structure with the importer credited as transcriber rather than original author'),
  moderator: pending('reads published recipe text and structure without moderation overriding source credit or private boundaries'),
  operator: pending('publishes and reads source-marked public-domain text and structure under the corresponding platform mandate'),
}, { rights: { basis: 'public-domain', credit: 'Bounded pinned extract from Project Gutenberg 65061, The Boston Cooking-School Cook Book (1910), Fannie Merritt Farmer, https://www.gutenberg.org/ebooks/65061; importer must be transcriber, never source author. This is no corpus-clearance claim.' } });
