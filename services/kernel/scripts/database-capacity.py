"""Run fixed-arrival PostgreSQL controls on a fresh, disk-backed, private instance."""
import argparse
import gzip
import json
import math
import os
import platform
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def run(*args, stdin=None):
    return subprocess.run(args, input=stdin, text=True, check=True, stdout=subprocess.PIPE).stdout.strip()


def summarize(log, report):
    latency = []
    skipped = failed = retries = 0
    for row in log.splitlines():
        fields = row.split()
        retries += int(fields[7])
        if fields[2].isdigit():
            latency.append(int(fields[2]))
        elif fields[2] == "skipped":
            skipped += 1
        elif fields[2] == "failed":
            failed += 1
        else:
            raise ValueError(f"Unrecognized pgbench outcome: {fields[2]}")
    # Verify that all client log files survived before computing percentiles.
    for label, count in [
        ("number of transactions actually processed", len(latency)),
        ("number of failed transactions", failed),
        ("number of transactions skipped", skipped),
        ("total number of retries", retries),
    ]:
        metric = re.search(r"^" + label + r": (\d+)", report, re.MULTILINE)
        if metric is None or int(metric[1]) != count:
            raise ValueError(f"pgbench report and per-transaction log disagree on {label}: {count}\n{report}")
    throughput = re.search(r"^tps = ([.\d]+)", report, re.MULTILINE)
    if not throughput:
        raise ValueError(f"Missing pgbench throughput\n{report}")
    latency.sort()

    def percentile(p):
        return latency[math.ceil(p * len(latency)) - 1] / 1000 if latency else None

    return dict(scheduled=len(latency) + skipped + failed, successes=len(latency), skipped=skipped, failed=failed,
                retries=retries, successful_per_s=float(throughput[1]), p95_ms=percentile(.95), p99_ms=percentile(.99))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Pinned Kernel PostgreSQL image with its digest")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--read-rates", nargs="+", type=int, default=[2200, 16000])
    parser.add_argument("--write-rates", nargs="+", type=int, default=[550, 5500])
    args = parser.parse_args()
    if min(args.seconds, *args.read_rates, *args.write_rates) < 1 or "@sha256:" not in args.image:
        parser.error("Supply positive rates and duration and a digest-pinned image")
    args.output.mkdir(parents=True, exist_ok=False)
    container = "database-capacity-" + uuid.uuid4().hex
    cotenants = len(run("docker", "ps", "-q").splitlines())
    run("docker", "run", "-d", "--rm", "--name", container, "--network", "none", "--cpus", "4", "--memory", "2g",
        "--shm-size", "128m", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", args.image, "-c", "shared_buffers=256MB")

    def execute(*argv, stdin=None):
        return run("docker", "exec", "-i", container, *argv, stdin=stdin)

    def sql(statement):
        return execute("psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", stdin=statement)

    try:
        for _ in range(240):
            ready = subprocess.run(["docker", "exec", container, "sh", "-c",
                                    'test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U postgres'])
            if ready.returncode == 0:
                break
            time.sleep(.25)
        else:
            raise RuntimeError("PostgreSQL startup timed out")
        execute("pgbench", "-U", "postgres", "-i", "-q", "-I", "dtGvp", "-F", "80", "-s", "10", "postgres")
        sql("CHECKPOINT")
        settings = json.loads(sql("""SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN
            ('fsync','synchronous_commit','full_page_writes','wal_sync_method','shared_buffers','block_size',
             'max_connections','checkpoint_timeout','synchronous_standby_names')"""))
        if any(settings[name] != "on" for name in ("fsync", "synchronous_commit", "full_page_writes")):
            raise RuntimeError("PostgreSQL local durability is disabled")
        filesystem = execute("sh", "-c", 'stat -f -c %T "$PGDATA"')
        if filesystem in ("tmpfs", "ramfs"):
            raise RuntimeError("Data directory must reside on disk")
        metadata = dict(image=args.image, postgres=execute("pgbench", "--version"), settings=settings,
                        host=os.environ.get("REZICS_CHECK_HOST", platform.node()), kernel=platform.release(),
                        observed_at=datetime.now(timezone.utc).isoformat(), run_id=os.getenv("REZICS_CHECK_RUN"),
                        cpu_max=execute("cat", "/sys/fs/cgroup/cpu.max"), memory_max=execute("cat", "/sys/fs/cgroup/memory.max"),
                        cpu=run("lscpu"), container_cpu_quota=4, container_memory_gib=2, cotenants=cotenants,
                        disks=run("lsblk", "-d", "-o", "NAME,MODEL,ROTA,SIZE"), filesystem=filesystem,
                        load=Path("/proc/loadavg").read_text().strip(), duration_s=args.seconds,
                        account_rows=int(sql("SELECT count(*) FROM pgbench_accounts")),
                        account_bytes=int(sql("SELECT pg_total_relation_size('pgbench_accounts')")),
                        read_plan=sql("EXPLAIN SELECT abalance FROM pgbench_accounts WHERE aid=500000"),
                        clients=24, threads=4, latency_limit_ms=250, max_tries=2)
        prefix = "\\set aid random(1,1000000)\n"
        outputs = []
        counter_query = """SELECT json_build_object('account_index_scans', idx_scan, 'updated_rows', n_tup_upd)
                           FROM pg_stat_user_tables WHERE relname='pgbench_accounts'"""
        print(f"Initialized {metadata['account_rows']} accounts on {metadata['filesystem']}", flush=True)
        for operation, statement, rates in [
            ("indexed-read", "SELECT abalance FROM pgbench_accounts WHERE aid=:aid;", args.read_rates),
            ("durable-commit", "UPDATE pgbench_accounts SET abalance=abalance+1 WHERE aid=:aid;", args.write_rates),
        ]:
            script = prefix + statement + "\n"
            script_path = "/tmp/capacity.sql"
            execute("sh", "-c", 'cat > "$1"', "sh", script_path, stdin=script)
            base = ["pgbench", "-n", "-U", "postgres", "-M", "prepared", "-c", "24", "-j", "4", "-f", script_path]
            execute(*base, "-T", "5", "-R", str(rates[0]), "--random-seed=17", "postgres")
            for rate in rates:
                name = f"{operation}-{rate}"
                load_start = Path("/proc/loadavg").read_text().strip()
                before = json.loads(sql(counter_query))
                lines = execute(*base, "-T", str(args.seconds), "-R", str(rate), "--random-seed=42", "-L", "250",
                                "--max-tries=2", "-l", "--log-prefix=/dev/shm/capacity", "postgres")
                after = json.loads(sql(counter_query))
                counters = {key: value - before[key] for key, value in after.items()}
                (args.output / (name + ".txt")).write_text(lines + "\n")
                log = execute("sh", "-c", "cat /dev/shm/capacity.* && rm /dev/shm/capacity.*")
                with gzip.open(args.output / (name + ".tsv.gz"), "wt") as file:
                    file.write(log + "\n")
                result = summarize(log, lines)
                outputs.append(dict(operation=operation, sql=script, offered_per_s=rate, load_start=load_start,
                                    postgres_counters=counters, **result))
                print(json.dumps(outputs[-1]), flush=True)
                (args.output / "summary.json").write_text(json.dumps(dict(metadata=metadata, runs=outputs), indent=2) + "\n")
    finally:
        run("docker", "rm", "-f", "-v", container)


if __name__ == "__main__":
    main()
