// Run on an isolated native stack with the ordinary Auth and Search workers.
import { sleep } from 'k6';
import { sha256 } from 'k6/crypto';
import { SharedArray } from 'k6/data';
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

function positiveInteger(name, fallback) {
  const value = Number(__ENV[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

const origin = __ENV.KERNEL_URL?.replace(/\/$/, '');
if (!origin || !__ENV.MIXED_FIXTURE) throw new Error('Set KERNEL_URL and an absolute MIXED_FIXTURE path');
const accounts = new SharedArray('actors', () => {
  const rows = JSON.parse(open(__ENV.MIXED_FIXTURE)).accounts;
  if (!Array.isArray(rows) || !rows.length || rows.some((x) => !x.id || !x.bearer))
    throw new Error('Fixture requires accounts with native id and bearer');
  if (new Set(rows.map((x) => x.id)).size !== rows.length) throw new Error('Duplicate fixture account');
  return rows;
});
const books = new SharedArray('books', () => {
  const rows = JSON.parse(open(__ENV.MIXED_FIXTURE)).subjects ?? [];
  if (!Array.isArray(rows) || rows.some((x) => !x.id || !x.text))
    throw new Error('Each fixture subject requires its id and searchable text');
  return rows;
});
const rate = positiveInteger('MIXED_RATE', 1000);
const seconds = positiveInteger('MIXED_SECONDS', 60);
const vus = positiveInteger('MIXED_VUS', 100);
const target = __ENV.MIXED_MIN_RPS ? positiveInteger('MIXED_MIN_RPS') : undefined;
const timeout = positiveInteger('MIXED_TIMEOUT_MS', 5000);
const probeLimit = positiveInteger('MIXED_FRESHNESS_MS', 30000);
const setupLimit = positiveInteger('MIXED_READY_MS', probeLimit);
const replayFallback = __ENV.MIXED_REPLAY_FALLBACK ?? 'per-actor';
if (!['per-actor', 'shared'].includes(replayFallback)) throw new Error('Invalid MIXED_REPLAY_FALLBACK');
const seedBatchSize = 4;

// One dispatch per slot. Count the occurrence of each operation in this cycle once, outside the measured loop.
const mix =
  'subject inbox subject search create inbox subject search subject inbox subject search replay subject inbox create search subject inbox subject'.split(
    ' ',
  );
const mixCounts = {};
const slots = mix.map((name) => {
  const offset = mixCounts[name] ?? 0;
  mixCounts[name] = offset + 1;
  return { name, offset };
});
const operations = Object.fromEntries(
  Object.keys(mixCounts).map((name) => [
    name,
    {
      valid: new Rate(`mixed_${name}_valid`),
      latency: new Trend(`mixed_${name}_ms`, true),
      completedInWindow: new Counter(`mixed_${name}_success_in_window`),
    },
  ]),
);
const started = new Counter('mixed_started');
const settled = new Counter('mixed_settled');
const seedReplays = new Counter('mixed_seed_replays');
const previousCreateReplays = new Counter('mixed_previous_create_replays');
const visible = new Counter('index_visible_samples');
const completedInWindow = new Counter('mixed_success_in_window');
const valid = new Rate('mixed_valid');
const latency = new Trend('mixed_ms', true);
const probeOk = new Rate('index_probe_visible');
const probeCreates = new Rate('index_probe_created');
const probeMs = new Trend('index_probe_ms', true);
const probeSearches = new Counter('index_probe_searches');
const errors = Object.fromEntries(
  ['transport', '401', '403', '404', '409', '422', '429', '500', '503', 'other_status', 'wrong_result'].map((name) => [
    name,
    new Counter(`mixed_error_${name}`),
  ]),
);

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: `${seconds}s`,
      preAllocatedVUs: vus,
      gracefulStop: `${timeout + 1000}ms`,
      exec: 'mixed',
    },
    index_visibility: {
      executor: 'constant-vus',
      vus: 1,
      duration: `${seconds}s`,
      gracefulStop: `${probeLimit + timeout + 7000}ms`,
      exec: 'indexVisibility',
    },
  },
  setupTimeout: `${setupLimit + (1 + Math.ceil(accounts.length / seedBatchSize)) * timeout + 15000}ms`,
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response', 'error_code'],
  thresholds: {
    mixed_valid: ['rate==1'],
    index_probe_visible: ['rate==1'],
    dropped_iterations: ['count==0'],
    mixed_settled: [`count>=${rate * seconds}`],
    index_visible_samples: ['count>0'],
    ...(target ? { mixed_success_in_window: [`count>=${target * seconds}`] } : {}),
  },
};

function requestArgs(name, path, method, account, body, key, limit = timeout) {
  const headers = {};
  if (account) headers.Authorization = `Bearer ${account.bearer}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = JSON.stringify(key);
  return [
    method,
    origin + path,
    body ? JSON.stringify(body) : null,
    {
      headers,
      tags: { name },
      redirects: 0,
      timeout: `${limit}ms`,
    },
  ];
}

function request(...args) {
  return http.request(...requestArgs(...args));
}

function value(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function createArgs(account, key) {
  return requestArgs(
    'subject.create',
    '/v1/subjects',
    'POST',
    account,
    {
      type: 'schema:Book',
      labels: { en: key },
    },
    key,
  );
}

function created(response, key) {
  const item = value(response)?.subject;
  const id =
    response.status === 201 &&
    item?.type === 'schema:Book' &&
    item.labels?.en === key &&
    item.revision === 1 &&
    typeof item.id === 'string' &&
    response.headers.Location === `/v1/subjects/${item.id}`
      ? item.id
      : null;
  return { response, id };
}

function create(account, key) {
  return created(http.request(...createArgs(account, key)), key);
}

function prepareReplayReceipts() {
  const receipts = [];
  for (let first = 0; first < accounts.length; first += seedBatchSize) {
    const seeds = Array.from({ length: Math.min(seedBatchSize, accounts.length - first) }, (_, offset) => {
      const account = first + offset;
      const key = `qreplay${sha256(accounts[account].id, 'hex').slice(0, 32)}`;
      return { account, key };
    });
    const replies = http.batch(seeds.map(({ account, key }) => createArgs(accounts[account], key)));
    for (const [i, { account, key }] of seeds.entries()) {
      const { response, id } = created(replies[i], key);
      if (!id) throw new Error(`Setup replay receipt for actor ${account} failed (HTTP ${response.status})`);
      receipts.push({ account, key, id });
    }
  }
  return receipts;
}

function search(account, book, limit = timeout) {
  const response = request(
    'subject.search',
    '/v1/subjects:search',
    'POST',
    account,
    {
      text: book.text,
      filter: { type: { in: ['schema:Book'] } },
      languages: ['en'],
      limit: 10,
    },
    undefined,
    limit,
  );
  const page = value(response);
  const found =
    response.status === 200 &&
    Number.isFinite(Date.parse(page?.as_of)) &&
    Array.isArray(page?.subjects) &&
    page.subjects.some((x) => x.id === book.id);
  return { response, found };
}

// Time from the create acknowledgement through the first Search page containing that exact ID.
function observeIndex(account, book, measured, observationLimit = probeLimit) {
  const ack = Date.now();
  const deadline = ack + observationLimit;
  let status;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = search(account, book, Math.min(timeout, remaining));
    status = result.response.status;
    if (measured) probeSearches.add(1);
    if (result.found && Date.now() <= deadline) return { ms: Date.now() - ack, status };
    if (status !== 200 && status !== 503 && status !== 429 && status !== 0) break;
    sleep(Math.min(250, Math.max(0, deadline - Date.now())) / 1000);
  } while (Date.now() < deadline);
  return { ms: null, status };
}

export function setup() {
  const receipts = prepareReplayReceipts();
  const run = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const key = `q${run}seed`;
  const { id, response } = create(accounts[0], key);
  if (!id)
    throw new Error(
      `Setup subject creation failed (HTTP ${response.status}, ${value(response)?.code ?? 'invalid subject'})`,
    );
  const result = observeIndex(accounts[0], { id, text: key }, false, setupLimit);
  if (result.ms === null) throw new Error(`Setup subject never became searchable (last HTTP ${result.status})`);
  return { run, seed: { id, key }, receipts };
}

let lastReceipt;
export function mixed({ run, seed, receipts }) {
  const index = execution.scenario.iterationInTest;
  const { name, offset } = slots[index % slots.length];
  // Rotate each operation independently, including actor/book counts divisible by the length of the mix.
  const occurrence = Math.floor(index / slots.length) * mixCounts[name] + offset;
  const actor = occurrence % accounts.length;
  const account = accounts[actor];
  const book = books.length ? books[occurrence % books.length] : { id: seed.id, text: seed.key };
  started.add(1);
  const start = Date.now();
  let response, ok;
  if (name === 'subject') {
    response = request('subject.read', `/v1/subjects/${book.id}`, 'GET');
    ok = response.status === 200 && value(response)?.subject?.id === book.id;
  } else if (name === 'inbox') {
    response = request('notifications.count', `/v1/accounts/${account.id}/notifications/count`, 'GET', account);
    const count = value(response);
    ok =
      response.status === 200 &&
      Number.isInteger(count?.count) &&
      count.count >= 0 &&
      count.count <= 100 &&
      typeof count.capped === 'boolean' &&
      ['current-visible-unread', 'current-visible-lower-bound'].includes(count.basis) &&
      count.witness?.kind === 'current-disclosure' &&
      Number.isFinite(Date.parse(count.witness.at));
  } else if (name === 'search') {
    const result = search(account, book);
    response = result.response;
    ok = result.found;
  } else if (name === 'create') {
    const key = `q${run}w${index.toString(36)}`;
    const made = create(account, key);
    response = made.response;
    ok = made.id !== null;
    if (ok) lastReceipt = { account: actor, id: made.id, key };
  } else {
    (lastReceipt ? previousCreateReplays : seedReplays).add(1);
    const receipt = lastReceipt ?? receipts[replayFallback === 'shared' ? 0 : actor];
    const replay = create(accounts[receipt.account], receipt.key);
    response = replay.response;
    ok = replay.id === receipt.id;
  }
  const end = Date.now();
  latency.add(end - start);
  operations[name].latency.add(end - start);
  settled.add(1);
  valid.add(ok === true);
  operations[name].valid.add(ok === true);
  const successfulInWindow = ok && end < execution.scenario.startTime + seconds * 1000 ? 1 : 0;
  completedInWindow.add(successfulInWindow);
  operations[name].completedInWindow.add(successfulInWindow);
  if (!ok) {
    const status = response.status;
    const reason =
      status === 0
        ? 'transport'
        : status >= 200 && status < 300
          ? 'wrong_result'
          : String(status) in errors
            ? String(status)
            : 'other_status';
    errors[reason].add(1);
  }
}

export function indexVisibility({ run }) {
  const i = execution.scenario.iterationInTest;
  const account = accounts[i % accounts.length];
  const key = `q${run}p${i.toString(36)}`;
  const { id } = create(account, key);
  probeCreates.add(id !== null);
  const sample = id ? observeIndex(account, { id, text: key }, true).ms : null;
  probeOk.add(sample !== null);
  visible.add(sample === null ? 0 : 1);
  if (sample !== null) probeMs.add(sample);
  sleep(5);
}

export function handleSummary({ metrics }) {
  const values = (metric) => metrics[metric]?.values ?? {};
  const operation = (name) => {
    const v = values(`mixed_${name}_valid`);
    const inWindow = values(`mixed_${name}_success_in_window`).count ?? 0;
    return {
      successful: v.passes ?? 0,
      failed: v.fails ?? 0,
      successfulInWindow: inWindow,
      successfulRps: inWindow / seconds,
      latencyMs: values(`mixed_${name}_ms`),
    };
  };
  const outcomes = values('mixed_valid');
  const successful = outcomes.passes ?? 0;
  const failed = outcomes.fails ?? 0;
  const inWindow = values('mixed_success_in_window').count ?? 0;
  const dispatched = values('mixed_started').count ?? 0;
  const probes = values('index_probe_visible');
  const dropped = values('dropped_iterations').count ?? 0;
  // The executor can schedule a final iteration exactly on the duration boundary.
  const planned = rate * seconds;
  const scheduled = dispatched + dropped;
  const report = {
    actorAndSubjectSha256: sha256(
      JSON.stringify([Array.from(accounts, (actor) => actor.id), Array.from(books, (book) => [book.id, book.text])]),
      'hex',
    ),
    mixPer20Arrivals: mixCounts,
    offeredRps: rate,
    durationSeconds: seconds,
    preAllocatedVUs: vus,
    targetRps: target ?? null,
    accounts: accounts.length,
    fixtureBooks: books.length || 1,
    planned,
    scheduled,
    dispatched,
    droppedByK6: dropped,
    missedArrivals: Math.max(planned, scheduled) - dispatched,
    unfinished: dispatched - successful - failed,
    successful,
    failed,
    successfulInWindow: inWindow,
    successfulRps: inWindow / seconds,
    latencyMs: values('mixed_ms'),
    operations: Object.fromEntries(Object.keys(operations).map((n) => [n, operation(n)])),
    replayFallback,
    setupReceiptReplays: values('mixed_seed_replays').count ?? 0,
    previousCreateReceiptReplays: values('mixed_previous_create_replays').count ?? 0,
    plannedReceiptReplays: (values('mixed_replay_valid').passes ?? 0) + (values('mixed_replay_valid').fails ?? 0),
    clientFailureRetries: 0,
    failures: Object.fromEntries(Object.keys(errors).map((n) => [n, values(`mixed_error_${n}`).count ?? 0])),
    indexVisibility: {
      observed: probes.passes ?? 0,
      failed: probes.fails ?? 0,
      createFailures: values('index_probe_created').fails ?? 0,
      notObservedAfterAck: (values('index_probe_created').passes ?? 0) - (probes.passes ?? 0),
      searches: values('index_probe_searches').count ?? 0,
      maxObservationMs: probeLimit,
      pollIntervalMs: 250,
      observedLatencyMs: values('index_probe_ms'),
    },
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  return { stdout: json, ...(__ENV.MIXED_REPORT ? { [__ENV.MIXED_REPORT]: json } : {}) };
}
