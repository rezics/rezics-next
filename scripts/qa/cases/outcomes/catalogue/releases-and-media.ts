import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('catalogue/releases-and-media', {
  visitor: pending('discovers exact public source releases and usable credited cover/portrait references; saving requires sign-in'),
  stranger: pending('saves and resumes only their own exact source edition and progress; public media retains its evidence'),
  member: pending('uses the same source edition and media contract; Realm membership exposes no other reader state or private evidence'),
  owner: pending('owns catalogue fixtures and their own choice without reading another reader state or publishing source art by implication'),
  moderator: pending('uses ordinary public release/media reads and own progress; moderation adds no reader or source-publication authority'),
  operator: pending('uses ordinary public release/media reads and own progress; platform authority adds no foreign reader or art ownership'),
}, {
  rights: {
    basis: 'source-specific-evidence',
    credit: 'Retained source records and official image references keep their actual attribution and use obligations. Database terms do not license artwork; no ownership of source art is claimed.',
  },
});
