import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/membership-and-admission', {
  visitor: proved(
    'sees only the bounded request landing and must authenticate to request admission',
  ),
  stranger: proved(
    'keeps one immutable pending request, recovers retries and withdraws only their own intent',
  ),
  member: proved('retains private member access without gaining admission administration'),
  owner: proved(
    'paginates requests and atomically declines or accepts one episode with CAS and replay',
  ),
  moderator: proved(
    'retains joined-member access but moderation does not authorize admission decisions',
  ),
  operator: proved(
    'can request as a stranger; platform authority cannot read the inbox or admit members',
  ),
});
