export const julian = 'http://www.wikidata.org/entity/Q1985786';
export const gregorian = 'http://www.wikidata.org/entity/Q1985727';
export const birth = {
  time: '-1234567890123456-02-29T00:00:00Z',
  precision: 11,
  calendarmodel: julian,
  timezone: -330,
  before: 2,
  after: 3,
};
export const zeroDate = {
  time: '+2000-04-00T00:00:00Z',
  timezone: 0,
  before: 0,
  after: 0,
  precision: 10,
  calendarmodel: gregorian,
};
export const height = {
  amount: '+9007199254740993.000000000000000001',
  lowerBound: '+9007199254740993.000000000000000000',
  upperBound: '+9007199254740993.000000000000000002',
  unit: 'http://www.wikidata.org/entity/Q11573',
};
export function claim(property: string, datatype: string, value: unknown, qualifiers?: Record<string, unknown[]>) {
  return {
    type: 'statement',
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property,
      datatype,
      datavalue: { type: datatype === 'wikibase-item' ? 'wikibase-entityid' : datatype, value },
    },
    ...(qualifiers ? { qualifiers } : {}),
    references: [
      {
        snaks: {
          P854: [
            {
              snaktype: 'value',
              property: 'P854',
              datatype: 'url',
              datavalue: { type: 'string', value: 'https://example.org/source-measurement' },
            },
          ],
        },
      },
    ],
  };
}
export function losslessRecord() {
  return {
    id: 'Q123456',
    type: 'item',
    lastrevid: 42,
    labels: { en: { language: 'en', value: 'Controlled person' } },
    claims: {
      P31: [claim('P31', 'wikibase-item', { id: 'Q5', 'entity-type': 'item', 'numeric-id': 5 })],
      P569: [
        claim('P569', 'time', birth),
        claim('P569', 'time', { ...birth, calendarmodel: 'http://www.wikidata.org/entity/Q1' }),
        claim('P569', 'time', { ...birth, precision: 12 }),
        claim('P569', 'time', { ...birth, timezone: 9007199254740992 }),
      ],
      P570: [
        claim('P570', 'time', { time: '+2000-00-00T00:00:00Z', precision: 9, calendarmodel: gregorian }),
        claim('P570', 'time', { time: '+2000-02-00T00:00:00Z', precision: 10, calendarmodel: julian }),
        claim('P570', 'time', zeroDate),
      ],
      P2048: [
        claim('P2048', 'quantity', height),
        claim('P2048', 'quantity', { ...height, lowerBound: '+9007199254740993.000000000000000002' }),
        claim('P2048', 'quantity', { ...height, unit: '1' }),
        claim('P2048', 'quantity', { unit: height.unit }),
      ],
      P6570: [
        claim(
          'P6570',
          'quantity',
          { amount: '+10', unit: '1' },
          { P459: [{ snaktype: 'somevalue', property: 'P459', datatype: 'wikibase-item' }] },
        ),
      ],
    },
  };
}
