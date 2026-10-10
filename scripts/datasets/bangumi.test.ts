import { expect, test } from 'bun:test';
import captured from '../../services/main/tests/bangumi-captured-subjects.json';
import { bangumiWorkFacts, type BangumiFactSource, type BangumiPublicationDate }
  from './bangumi.ts';

const subjects = captured as Record<string, BangumiFactSource>;
const day = 'http://www.w3.org/2001/XMLSchema#date';
const year = 'http://www.w3.org/2001/XMLSchema#gYear';
const on = (lexical: string, datatype: BangumiPublicationDate['datatype']): BangumiPublicationDate =>
  ({ lexical, datatype });

test('an anime first air date and a book first publication date keep the source precision', () => {
  expect(bangumiWorkFacts(subjects['975']!).date).toEqual(on('1999-10-20', day));
  expect(bangumiWorkFacts(subjects['1869']!).date).toEqual(on('2000-03-04', day));
  expect(bangumiWorkFacts(subjects['3582']!).date).toEqual(on('2007-11-10', day));
  expect(bangumiWorkFacts(subjects['20700']!).date).toEqual(on('2010-01-29', day));
  expect(bangumiWorkFacts({
    id: 1, type: 2, platform: 1, infobox: '|放送开始= 1998年\n|发售日= 1998-07-26',
  }).date).toEqual(on('1998', year));
  expect(bangumiWorkFacts({ id: 2, type: 1, platform: 1001, date: '2012' }).date).toEqual(on('2012', year));
});

test('the API date, then the archive date, then the infobox, and a blank field is skipped', () => {
  const infobox = '|放送开始= 1990年1月2日\n|发售日= 1991-03-04';
  expect(bangumiWorkFacts({
    id: 3, type: 2, platform: 1, date: '1992-05-06', infobox,
    api_subject: { type: 2, platform: 1, date: '1993-07-08', infobox: '|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1993-07-08', day));
  expect(bangumiWorkFacts({
    id: 4, type: 2, platform: 1, date: '1992-05-06', infobox,
    api_subject: { type: 2, platform: 1, date: '   ', infobox: '|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1992-05-06', day));
  expect(bangumiWorkFacts({
    id: 5, type: 2, platform: 1, date: '', infobox,
    api_subject: { type: 2, platform: 1, infobox: '|上映年度= \n|放送开始= 1994年8月9日' },
  }).date).toEqual(on('1994-08-09', day));
  expect(bangumiWorkFacts({
    id: 6, type: 1, platform: 1001, infobox: '|发行日期= 1988年2月3日\n|开始= 1980-01-01',
  }).date).toEqual(on('1988-02-03', day));
});

test('a missing, partial or malformed date states nothing, and a later field does not fill it in', () => {
  expect(bangumiWorkFacts({ id: 7, type: 2, platform: 1 }).date).toBeNull();
  expect(bangumiWorkFacts({ id: 8, type: 2, platform: 1, date: '   ', infobox: '|放送开始= ' }).date).toBeNull();
  for (const date of ['1999-10', '1999年10月', '1999-02-31', 'not-a-date', '1997-07-22 (1997年34号)', '0000-00-00']) {
    expect(bangumiWorkFacts({
      id: 9, type: 2, platform: 1, date, infobox: '|放送开始= 1999年10月20日',
    }).date, date).toBeNull();
  }
  expect(bangumiWorkFacts(subjects['3510']!).date).toEqual(on('1997-12-24', day));
});
