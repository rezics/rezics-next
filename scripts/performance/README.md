# Capacity workloads

## Mixed API

Run `mixed-api.js` with Grafana k6 (verified with 1.6.1) on the isolated Kernel deployment under test. Enable the ordinary Auth and Search workers, apply the active release, wait for first publication of the Search generation, and issue native Auth bearer tokens to fixture accounts with Global `subject:create`. On a fresh index the worker can write documents before the read alias is active. Let the default worker finish its original Source and writer reconciliation. The operator command `bun run --cwd services/kernel search rebuild` can initiate or resume a rebuild and waits for native publication. The workload creates permanent Books in that database. Each optional fixture Book must be publicly readable and appear among the first ten results of its English text search. With no fixture Books, setup creates and indexes one hot Book.

Store the private fixture JSON with mode 0600. Its shape is `{"accounts":[{"id":"…","bearer":"…"}],"subjects":[{"id":"…","text":"…"}]}`. Give each account its own ID and a bearer valid throughout setup and the measured window. Keep production rate budgets enabled and size the actor population for the offered write and search rates.

```sh
KERNEL_URL=http://127.0.0.1:4100 MIXED_FIXTURE="$PWD/.temp/performance/fixture.json" \
  MIXED_RATE=1050 MIXED_MIN_RPS=1000 MIXED_SECONDS=60 MIXED_VUS=150 \
  MIXED_REPORT="$PWD/.temp/performance/mixed-api.json" \
  k6 run --quiet --no-usage-report scripts/performance/mixed-api.js
```

Every 20 scheduled arrivals contain eight public Subject reads, five authenticated unread counts, four authenticated Book searches, two unique Book creates and one exact receipt replay. Replay returns the original subject ID. Each VU reuses its last successful create or the setup receipt. Failed requests have zero application retries. A separate VU creates a uniquely named Book and observes the time from its acknowledgement through the first Search result containing its exact ID. Probe requests and setup stay outside mixed traffic. `MIXED_FRESHNESS_MS` bounds each observation (default 30,000 ms); `MIXED_TIMEOUT_MS` bounds each HTTP call (default 5,000 ms). For a cold stack, set `MIXED_READY_MS` to a longer setup-only visibility window.

The reported successful requests/s count semantically valid responses completed inside the fixed arrival window. The report includes late completions in total successes, along with failure causes, unfinished arrivals, dropped work, per-operation latency and visibility samples. Supply `MIXED_MIN_RPS` for a measured throughput threshold. Keep the report with the server revision, hardware, dataset, durability settings and worker configuration for the run.

## Database controls

Run the PostgreSQL control on the test host with Docker. The script starts a private, disk-backed instance,
initializes one million indexed account rows, and runs uniform point reads and single-row committed updates.
Pass the exact `POSTGRES_IMAGE` digest from `services/kernel/scripts/database.ts` and an unused output directory.

```sh
python3 services/kernel/scripts/database-capacity.py --image "$POSTGRES_IMAGE" --output .temp/capacity-db
```

The default offers 2,200 and 16,000 reads/s, then 550 and 5,500 commits/s for 30 seconds per level with 24 clients.
The generator shares the database's 4-CPU, 2-GiB container and uses the local Unix socket. The result directory
contains durability settings, observed table counters, pgbench summaries and compressed transaction logs.
