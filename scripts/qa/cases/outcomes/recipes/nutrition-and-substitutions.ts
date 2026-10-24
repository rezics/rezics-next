import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/nutrition-and-substitutions', {
  visitor: pending('reads published source-qualified nutrient values and exact alternatives without inventing missing nutrition or saving private cook state'),
  stranger: pending('reads the same published nutrients and author-declared alternatives and can recover only own cook progress'),
  member: pending('reads qualified nutrients and exact alternatives without membership granting publication or another cook’s state'),
  owner: pending('reads the pinned publication after a private draft and recovers own cooking without changing the source’s nutrition meaning'),
  moderator: pending('reads qualified public nutrients and alternatives with ordinary reader authority and no access to another cook’s state'),
  operator: pending('uses scoped fixture publication authority separately and reads qualified public nutrients with only own cooking state'),
}, { rights: { basis: 'public-domain',
  credit: 'Frozen source attribution and assessed publication rights are prerequisites; source author and transcriber remain distinct. No nutrition values or substitutions are supplied by this declaration.' } });
