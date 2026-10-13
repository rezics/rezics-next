import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/author-a-recipe', {
  visitor: proved('reads published duplicate ingredients and credited author while later drafts stay private'),
  stranger: proved('authors an original recipe while peer editing, publication and later drafts stay private'),
  member: proved('publishes an original ordered recipe and reads only the peer author’s published revision'),
  owner: proved('publishes duplicate occurrences, pins the public revision and restores a private draft safely'),
  moderator: proved('reads the credited public revision with no peer draft or author authority from moderation'),
  operator: proved('reads the credited public revision with no peer draft or author authority from platform status'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fixture recipes and ingredient/step occurrences by their author Person; public native author credits identify that Person.',
} });
