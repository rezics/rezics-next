import { sortName } from './title-sort-key.ts';
export { sortName } from './title-sort-key.ts';
import { collectSemanticRecordFacts } from './record-source-set.ts';
import type { Release } from '@rezics/definitions';
import { chooseLabel, languageRanges } from './language.ts';
import type { FactRow } from './item.ts';
import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { slotView } from './slots.ts';
import readSubject from './read-holder-facts.sql';

/** Unlocalized projection keys use the shared label rule without reader or original-language preferences. */
export function subjectLabel(labels: Record<string, string>, language?: string): string {
  return chooseLabel(labels, languageRanges(null, language))?.value ?? '';
}
/** Fixed-width decimal scientific encoding; preserves integer ordinals beyond Number's precision. */
export function positionKey(value: unknown): string {
  const text = typeof value === 'string' ? value : (value as { amount?: string } | null)?.amount;
  const match = text?.match(/^([+-]?)([0-9]+)(?:\.([0-9]+))?$/);
  if (!match) return '1';
  const digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '01' + '0'.repeat(1506);
  const exponent = digits.length - (match[3]?.length ?? 0);
  const magnitude = String(200000 + exponent).padStart(6, '0') + digits.padEnd(1500, '0');
  return match[1] === '-' ? '00' + magnitude.replace(/[0-9]/g, (c) => String(9 - Number(c))) : '02' + magnitude;
}
export function dateOrderKey(value: unknown): string {
  const time = (value as { time?: string } | null)?.time;
  const match = time?.match(/^([+-][0-9]+)-(\d{2})-(\d{2})T/);
  if (!match) return '1';
  return positionKey(match[1]) + match[2] + match[3];
}
export function holderKeys(facts: readonly FactRow[], type: string) {
  const labels: Record<string, string> = {};
  const dates: string[] = [];
  for (const fact of facts) {
    if (fact.kind === 'label' && fact.language !== null) {
      if (fact.operation === 'retract') delete labels[fact.language];
      else if (typeof fact.body === 'string') labels[fact.language] = fact.body;
    }
    const body = fact.body as { rank?: string; value?: { type: string; content?: unknown } };
    if (
      fact.property === 'schema:datePublished' &&
      fact.operation === 'assert' &&
      body.rank !== 'deprecated' &&
      body.value?.type === 'value'
    )
      dates.push(dateOrderKey(body.value.content));
  }
  const label = subjectLabel(labels);
  return {
    source_type: type,
    label,
    name: label ? '0' + [...sortName(label)].slice(0, 256).join('') : '1',
    date: dates.sort()[0] ?? '1',
    dates,
  };
}

export function labelOrderKey(labels: Record<string, string>): string {
  const label = subjectLabel(labels);
  return label ? '0' + [...sortName(label)].slice(0, 256).join('') : '1';
}

/** Holder identity facts used to derive link keys; it never walks relation slots. */
export async function holderFacts(
  tx: CommandTransaction,
  subject: string,
  _release: Release,
): Promise<{ type: string; facts: FactRow[] }> {
  const rows = await readSubject.run(tx, { route: routeOf(subject)!, subject_id: subject });
  const type = rows[0]?.type;
  if (!type) throw new Error('Link holder is missing');
  const facts: FactRow[] = rows
    .filter((row) => row.kind === 'label')
    .map((row) => ({ ...row, kind: 'label' as const, operation: row.operation as FactRow['operation'] }));
  facts.push(...(await slotView(tx, subject, 'schema:datePublished')).facts);
  await collectSemanticRecordFacts(tx, subject, facts);
  return { type, facts };
}

/** The identity keys needed by one page of target-key re-emission. */
export async function readHolderKeys(pool: Pool, subject: string) {
  return withConnection(pool, async (client) => {
    const identity = await holderFacts(client, subject, {} as Release);
    return holderKeys(identity.facts, identity.type);
  });
}
