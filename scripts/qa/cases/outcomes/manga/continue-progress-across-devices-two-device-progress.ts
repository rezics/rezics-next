import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('manga/continue-progress-across-devices-two-device-progress', {
  visitor: proved('sees public opening chapters and cannot read or save private progress'),
  stranger: proved('two own Account authorizations share chapter progress and stale undo; a foreign reader stays unchanged'),
  member: proved('two own devices resume across volumes and omnibus, replay a save and recover from stale undo without foreign library effects'),
  owner: proved('two own devices agree after undo; owning the Manga supplies no access to another reader’s progress or timestamps'),
  moderator: proved('two own devices resume and recover; joined moderation supplies no foreign reader identity'),
  operator: proved('two own devices resume and recover; platform and Work mandates supply no foreign Account or library identity'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fictional manga text and chapter labels by the fixture owner Person, with native author credit.',
} });
