import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/identity-discovery', {
  visitor: pending('requires sign-in for identity discovery and session choice without changing the public reader'),
  stranger: pending('distinguishes authenticated empty, eligible, unselected, denied and unavailable identities and preserves login return'),
  member: pending('discovers only represented Agents, preserves session choice and login return through owner failure'),
  owner: pending('discovers only represented Agents, preserves session choice and login return through owner failure'),
  moderator: pending('keeps moderation separate from Agent eligibility and preserves session and login return through failure'),
  operator: pending('keeps platform authority separate from Agent eligibility and preserves session and login return through failure'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Synthetic Account identities, Agent names and original Book text authored by the isolated fixture people.',
} });
