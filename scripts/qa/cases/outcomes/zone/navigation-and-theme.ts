import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/navigation-and-theme', {
  visitor: proved('reads the published bundle without saved draft navigation'),
  stranger: proved('cannot read draft navigation or edit the published bundle'),
  member: proved('Realm membership does not reveal draft navigation or grant Zone editing'),
  owner: proved('previews drafts and atomically publishes navigation, theme and home after stale refusals'),
  moderator: proved('joined Realm moderation does not reveal draft navigation or grant Zone editing'),
  operator: proved('platform status does not reveal draft navigation or grant Zone editing'),
}, {
  rights: { basis: 'original-contribution', credit: 'Owner-authored home remains credited to its owner Person.' },
});

