import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const fixture = JSON.parse(open('/artifacts/load-cases.json'));
const cases = Object.fromEntries(fixture.cases.map(item => [item.name, item]));
const wheel = [
  'hot-main', 'other-main', 'hot-main', 'realm-adoption', 'hot-main',
  'content', 'hot-main', 'chinese-main', 'hot-main', 'rejected-candidate',
  'hot-main', 'other-main', 'hot-main', 'realm-fallback', 'hot-main',
  'content', 'hot-main', 'chinese-main', 'hot-main', 'realm-adoption',
];
const mainReads = new Counter('practical_main_reads');
const realmReads = new Counter('practical_realm_reads');
const contentReads = new Counter('practical_content_reads');
const hotReads = new Counter('practical_hot_reads');
const readLatency = {
  main: new Trend('practical_main_read_ms'),
  realm: new Trend('practical_realm_read_ms'),
  content: new Trend('practical_content_read_ms'),
};
const serverErrors = new Rate('practical_server_errors');
const seconds = Number(__ENV.DURATION_SECONDS);
const full = Number(__ENV.WORKS) === 10000 && seconds === 180;
let failureSamples = 0;

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: { practical_public_reads: { executor: 'constant-vus', vus: 8,
    duration: `${seconds}s`, gracefulStop: '5s' } },
  thresholds: {
    http_req_failed: ['rate==0'], checks: ['rate==1'],
    http_req_duration: [`p(95)<${full ? 1500 : 2500}`],
    http_reqs: [`count>=${full ? 240 : 20}`], practical_server_errors: ['rate==0'],
  },
};

export default function () {
  const selected = wheel[(__ITER + __VU) % wheel.length];
  const hot = fixture.hot[(__ITER * 31 + __VU) % fixture.hot.length];
  const item = selected === 'hot-main'
    ? { name: 'hot-main', lane: 'main', phrase: hot.token, language: hot.language,
      expectedWork: hot.work } : cases[selected];
  const body = { profile: item.lane === 'realm' ? 'public-realm-phrase-v1'
    : item.lane === 'content' ? 'public-content-phrase-v1' : 'public-main-phrase-v1',
    ...(item.lane === 'realm' ? { context: { kind: 'realm-local', id: fixture.realm } } : {}),
    phrase: item.phrase, language: item.language };
  const response = http.post(`${__ENV.MAIN_BASE_URL}/v1/queries`, JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    tags: { lane: item.lane, case: item.name }, timeout: '5s',
  });
  readLatency[item.lane].add(response.timings.duration);
  if (item.lane === 'main') mainReads.add(1);
  if (item.lane === 'realm') realmReads.add(1);
  if (item.lane === 'content') contentReads.add(1);
  if (selected === 'hot-main') hotReads.add(1);
  serverErrors.add(response.status >= 500);
  let result;
  try { result = response.json(); } catch { result = null; }
  const valid = response.status === 200
    && result?.contractVersion === '1' && result?.complete === true
    && result?.population === (item.lane === 'content'
      ? fixture.contentPopulation : fixture.graphPopulation)
    && result?.total === (item.expectedWork === null ? 0 : 1)
    && result?.results?.length === result.total
    && (item.expectedWork === null || result.results[0]?.[
      item.lane === 'content' ? 'resource' : 'work'] === item.expectedWork)
    && (!item.expectedContribution || result.results[0]?.contribution === item.expectedContribution)
    && (!item.expectedReason || result.results[0]?.reason === item.expectedReason)
    && typeof result?.indexGeneration === 'string';
  check(response, { 'complete exact practical snapshot': () => valid });
  if (!valid && failureSamples++ < 3) console.error(JSON.stringify({
    case: item.name, status: response.status, body: response.body?.slice(0, 500),
    expectedWork: item.expectedWork, expectedPopulation: item.lane === 'content'
      ? fixture.contentPopulation : fixture.graphPopulation }));
  sleep(0.55);
}
