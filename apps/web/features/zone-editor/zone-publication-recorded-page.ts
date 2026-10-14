import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { readZoneSiteRecorded, type ZoneSiteRecordedLoad } from '../zones/zone-site-recorded-page.ts';

/**
 * Publication's public page is the Zone site. The site route and this page call
 * the same mapping, so a story cannot show a cut the presentation did not carry.
 * A signed-in visit puts `actingSubject` on the query; the anonymous reread does not.
 */

/** Replay the selected public reads through the typed client and the shared site mapping. */
export function readZonePublicationRecorded(
  fetcher: typeof fetch,
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): Promise<ZoneSiteRecordedLoad> {
  return readZoneSiteRecorded(fetcher, record, persona, selections);
}

function sampleOf(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

/** The Zone the management configuration names, and the acting Person on that read. */
export function managementVisit(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): { space: string; actingSubject: string } {
  const actingSubject = recordedActingPerson(record, persona, selections);
  if (!actingSubject) throw new Error(`Management visit ${record.row}/${persona} has no acting Person`);
  for (const selection of selections) {
    const space = /\/v1\/zones\/([0-9a-f-]{36})\/configuration(?:\?|$)/.exec(sampleOf(record, persona, selection.label).path)?.[1];
    if (space) return { space, actingSubject };
  }
  throw new Error(`Management visit ${record.row}/${persona} has no configuration read`);
}

/** The viewer's acting Person on these reads. Absent when the recorded request has none. */
export function recordedActingPerson(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): string | null {
  for (const selection of selections) {
    const acting = new URL(sampleOf(record, persona, selection.label).path, 'https://recorded.invalid')
      .searchParams.get('actingSubject');
    if (acting) return acting;
  }
  return null;
}
