import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/publication', {
  visitor: proved('cannot publish or replay an owner receipt and leaves the public cut intact'),
  stranger: proved('cannot publish with its subject or replay another principal receipt'),
  member: proved('Realm membership cannot publish or replay the owner publication'),
  owner: proved('discarded HTTP acknowledgement replays original exact cuts after a competing publication'),
  moderator: proved('joined Realm moderation cannot publish or obtain the owner receipt'),
  operator: pending('needs an exact resource mandate to publish and retains the original owner credit'),
}, {
  rights: { basis: 'original-contribution', credit: 'Owner Person authors the Content; independently authorized operator publication retains that author.' },
});

