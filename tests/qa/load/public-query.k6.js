import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

const fixture = JSON.parse(open('/artifacts/load-cases.json'));
const cases = Object.fromEntries(fixture.cases.map(item => [item.name, item]));
// One of ten Works is the hot 10% and receives exactly half the offered requests.
const wheel = [
  'hot-main', 'other-main', 'hot-main', 'realm-adoption', 'hot-main',
  'content', 'hot-main', 'chinese-main', 'hot-main', 'rejected-candidate',
  'hot-main', 'other-main', 'hot-main', 'realm-fallback', 'hot-main',
  'content', 'hot-main', 'chinese-main', 'hot-main', 'realm-adoption',
];
const laneCounts = {
  main: new Counter('load_main_reads'), realm: new Counter('load_realm_reads'),
  content: new Counter('load_content_reads'),
};
const hotReads = new Counter('load_hot_reads');
const serverErrors = new Rate('load_server_errors');

export const options = {
  scenarios: {
    mixed_public_phrase: { executor: 'constant-vus', vus: 2, duration: '20s', gracefulStop: '5s' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2500'],
    'http_req_duration{lane:main}': ['p(95)<1500'],
    'http_req_duration{lane:realm}': ['p(95)<1500'],
    'http_req_duration{lane:content}': ['p(95)<2500'],
    http_reqs: ['count>=20'],
    checks: ['rate==1'],
    load_main_reads: ['count>=10'],
    load_realm_reads: ['count>=3'],
    load_content_reads: ['count>=1'],
    load_hot_reads: ['count>=8'],
    load_server_errors: ['rate==0'],
  },
};

export default function () {
  const item = cases[wheel[__ITER % wheel.length]];
  const body = { profile: item.lane === 'realm' ? 'public-realm-phrase-v1'
    : item.lane === 'content' ? 'public-content-phrase-v1' : 'public-main-phrase-v1',
    ...(item.lane === 'realm' ? { context: { kind: 'realm-local', id: fixture.realm } } : {}),
    phrase: item.phrase, language: item.language };
  const response = http.post(`${__ENV.MAIN_BASE_URL}/v1/queries`, JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    tags: { lane: item.lane, case: item.name }, timeout: '5s',
  });
  laneCounts[item.lane].add(1);
  if (item.name === 'hot-main') hotReads.add(1);
  serverErrors.add(response.status >= 500);
  let result;
  try { result = response.json(); } catch { result = null; }
  check(response, {
    'complete exact public snapshot': r => r.status === 200
      && result?.contractVersion === '1' && result?.complete === true
      && result?.population === (item.lane === 'content'
        ? fixture.contentPopulation : fixture.graphPopulation)
      && result?.total === (item.expectedWork === null ? 0 : 1)
      && result?.results?.length === result.total
      && (item.expectedWork === null || result.results[0]?.[item.lane === 'content' ? 'resource' : 'work']
        === item.expectedWork)
      && (!item.expectedContribution || result.results[0]?.contribution === item.expectedContribution)
      && (!item.expectedReason || result.results[0]?.reason === item.expectedReason)
      && typeof result?.indexGeneration === 'string'
      && (item.lane === 'content'
        ? typeof result?.contentPosition?.sequence === 'string'
        : result?.sourcePosition?.datasetId === 'product'
          && typeof result?.sourcePosition?.sequence === 'string'),
  });
  sleep(0.1);
}
