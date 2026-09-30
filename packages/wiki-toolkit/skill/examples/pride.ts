// SPDX-License-Identifier: Apache-2.0
// Jane Austen's public-domain text supplies the quote; this scaffolding is Apache-2.0.
import { parseFile } from '@rezics/wiki-toolkit';
import type { WikiExtraction } from '@rezics/wiki-toolkit/protocol';

/** Model-free worked example. IDs come from discovery/alignment, never from the filename. */
export function prideExample(
  bytes: Uint8Array,
  ids: {
    target: string;
    zone: string;
    continuity: string;
    occurrence: string;
    predicate: string;
    match?: string;
  },
): WikiExtraction {
  const parsed = parseFile(bytes, 'txt');
  const unit = parsed.units.find((candidate) => candidate.text.includes('My dear Mr. Bennet'));
  if (!unit || unit.locator.source.type !== 'external')
    throw new Error('Expected the admitted Pride and Prejudice text');
  const exact = 'My dear Mr. Bennet';
  const start = unit.text.indexOf(exact),
    locator = parsed.locate(unit, start, start + exact.length);
  if (parsed.verify(locator).quote !== exact)
    throw new Error('Example quote failed local verification');
  return {
    profile: 'wiki-extraction-v1',
    target: ids.target,
    zone: ids.zone,
    continuity: ids.continuity,
    source: {
      representationSha256: unit.locator.source.representationSha256,
      mediaType: 'text/plain',
      language: 'en',
      rightsBasis: 'public_domain',
      method: {
        agent: 'REZICS skill example',
        model: 'none (scripted fixture)',
        inference: 'local',
      },
    },
    units: [
      {
        id: unit.id,
        ordinal: unit.ordinal,
        label: unit.label.slice(0, 200),
        occurrence: ids.occurrence,
      },
    ],
    entities: [
      {
        id: 'mr-bennet',
        type: 'https://rezics.com/vocab/Character',
        ...(ids.match ? { match: ids.match } : {}),
        names: [{ value: 'Mr. Bennet', language: 'en', kind: 'primary', revealedAt: unit.id }],
      },
    ],
    claims: [
      {
        subject: 'mr-bennet',
        predicate: ids.predicate,
        object: { kind: 'literal', value: 'Mr. Bennet', language: 'en' },
        modality: 'said',
        continuity: ids.continuity,
        revealedAt: unit.id,
        evidence: [{ quote: exact, locator }],
      },
    ],
  };
}
