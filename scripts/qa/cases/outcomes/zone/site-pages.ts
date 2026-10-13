import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/site-pages', {
  visitor: proved('reads the exact published home and credit without unpublished bytes'),
  stranger: proved('reads the published home but cannot read or author its draft'),
  member: proved('Realm membership does not reveal or authorize a Realm-less site draft'),
  owner: proved('prepares the home identity, saves and republishes exact revisions without a Realm, and publishes all 32 digest-qualified pages with a complete receipt'),
  moderator: proved('joined Realm moderation does not reveal or authorize a site draft'),
  operator: proved('platform status does not reveal or authorize an unrelated site draft'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'Original home document authored by the owner Person; publication retains that author.',
  },
});

