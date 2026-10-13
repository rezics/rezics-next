import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/home-rendering', {
  visitor: proved('resolves the published Showcase and unknown placeholder without draft bytes or navigation'),
  stranger: proved('reads published home data and credit without draft editor access or navigation'),
  member: proved('Realm membership preserves the published home and draft privacy'),
  owner: pending('explicitly previews the saved draft while public home keeps its published document'),
  moderator: proved('joined moderation preserves the published home and draft privacy'),
  operator: proved('platform status preserves the published home and draft privacy'),
}, {
  rights: { basis: 'original-contribution', credit: 'Owner Person authored the home; unknown extension payload is original fixture material.' },
});

