#!/usr/bin/env python3
"""Explicit source-only launches. See ../src/code-only-launch.md for the local contract."""

import argparse
import contextlib
import datetime
import fcntl
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import uuid


SELF = Path(__file__).resolve()
GIB = 1024 ** 3
SLICE = "rezics-code-only.slice"
SAFETY_SLICE = "rezics.slice"
TERMINAL = {"finished", "failed", "interrupted"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_json(path):
    return json.loads(path.read_text())


def atomic_json(path, value):
    """All callers hold both writer locks; distinct temp names survive interrupted writes."""
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def locked(state):
    state.mkdir(parents=True, exist_ok=True)
    with (state / "code-only-writers.lock").open("a") as outer:
        fcntl.flock(outer, fcntl.LOCK_EX)
        root = state / "code-only"
        (root / "launches").mkdir(parents=True, exist_ok=True)
        # Keep the prototype's legacy lock second and never replace either lock inode.
        with (root / "writers.lock").open("a") as inner:
            fcntl.flock(inner, fcntl.LOCK_EX)
            yield


def valid_identity(value):
    return (
        isinstance(value, dict)
        and type(value.get("pid")) is int and value["pid"] > 0
        and type(value.get("group")) is int and value["group"] > 0
        and isinstance(value.get("start"), str) and value["start"].isdigit()
        and isinstance(value.get("boot"), str) and bool(value["boot"])
    )


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
    if fields[0] in {"Z", "X", "x"}:
        return None
    return {"pid": pid, "start": fields[19],
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "group": int(fields[2])}


def same_process(value):
    if not valid_identity(value):
        raise ValueError("invalid recorded process identity")
    # Permission/IO errors are unknown ownership, not proof that a PID is gone.
    return identity(value["pid"]) == value


def process_key(value):
    return tuple(value[key] for key in ("pid", "start", "boot", "group"))


def record_path(state, name):
    return state / "code-only" / "launches" / (name + ".json")


def record_context(value):
    path = Path(value).resolve()
    if path.parent.name != "launches" or path.parent.parent.name != "code-only":
        raise ValueError("record must be <state>/code-only/launches/<id>.json")
    rec = read_json(path)
    if path.stem != rec["id"] or rec.get("mode") != "code-only":
        raise ValueError("record identity does not match its path")
    return path, path.parent.parent.parent


def registry(state):
    path = state / "code-only-writers.json"
    value = read_json(path) if path.exists() else {"version": 1, "writers": []}
    if value.get("version") != 1 or not isinstance(value.get("writers"), list):
        raise ValueError("invalid code-only writers registry")
    live = []
    ids = set()
    for row in value["writers"]:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str)
                or not all(key in row for key in ("manager", "goal", "worktree"))
                or row.get("phase") != "writing" or row["id"] in ids):
            raise ValueError("invalid or duplicate code-only writer row")
        ids.add(row["id"])
        if same_process(row.get("identity")):
            live.append(row)
    return live


def publish(state, rec):
    rows = registry(state)
    previous = next((row for row in rows if row["id"] == rec["id"]), None)
    if previous and previous["identity"] != rec.get("identity"):
        raise ValueError("writer ID belongs to another live process")
    rows = [row for row in rows if row["id"] != rec["id"]]
    if rec["state"] == "running" and same_process(rec["identity"]):
        row = {key: rec[key] for key in ("id", "manager", "goal", "identity", "worktree")}
        row.update(phase="writing", ownedPaths=rec["ownedPaths"], unit=rec["unit"],
                   profile={"cli": rec["cli"], "pool": rec["pool"], "model": rec["model"],
                            "effort": "max", "serviceTier": "default"},
                   source=rec.get("source"))
        rows.append(row)
    atomic_json(state / "code-only-writers.json", {"version": 1, "writers": rows})


def save(state, path, rec):
    # Checkpoints reload under the same lock, so terminal and source fields cannot overwrite each other.
    atomic_json(path, rec)
    publish(state, rec)


def owned_paths(values):
    paths = set()
    for value in values:
        path = PurePosixPath(value)
        if (not value or path.is_absolute() or ".." in path.parts or not path.parts
                or path.parts[0] in {".git", ".temp"} or "\\" in value
                or any(char in value for char in "\n\r\0*?[]")):
            raise ValueError("claims must be literal repository-relative source paths")
        paths.add(str(path))
    return sorted(paths)


def overlap(left, right):
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def native_writers(state):
    """Read the current-generation projection, never historical attempts or native reservations."""
    database = state / "goal.sqlite"
    # mode=ro does not create a database or run WorkerStore migrations.
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        rows = connection.execute("""
            SELECT c.task_id, c.pid, c.process_start, c.process_boot, c.process_group,
                   json_extract(t.body, '$.brief.paths')
            FROM worker_current_attempts AS c
            JOIN worker_tasks AS t ON t.id=c.task_id
            WHERE c.pid IS NOT NULL
        """).fetchall()
    finally:
        connection.close()
    result = []
    for task, pid, start, boot, group, paths in rows:
        value = {"pid": pid, "start": start, "boot": boot, "group": group}
        if same_process(value):
            result.append({"id": task, "identity": value,
                           "ownedPaths": json.loads(paths) if paths else []})
    return result


def claim_prefix(value):
    # Native briefs may use globs. Their literal prefix conservatively owns its neighborhood.
    parts = re.split(r"[*?\[]", value.replace("\\", "/").removeprefix("./"), 1)
    prefix = parts[0]
    if len(parts) > 1 and not prefix.endswith("/"):
        return str(PurePosixPath(prefix).parent)
    return prefix.rstrip("/") or "."


def pending_launches(state, exclude_id):
    directory = state / "code-only" / "launches"
    pending = []
    for path in sorted(directory.glob("*.json")):
        row = read_json(path)
        if row.get("id") != path.stem or row.get("mode") != "code-only":
            raise RuntimeError("invalid retained code-only launch record: " + path.name)
        if row.get("id") != exclude_id and row.get("state") in {"preparing", "queued"}:
            if not isinstance(row.get("ownedPaths"), list):
                raise RuntimeError("setup launch has unavailable path ownership: " + row["id"])
            pending.append(row)
    return pending


def admit(state, claims, limit, exclude_id):
    direct = registry(state)
    native = native_writers(state)
    pending = pending_launches(state, exclude_id)
    keys = {process_key(row["identity"]) for row in direct + native}
    if len(keys) + len(pending) >= limit:
        raise RuntimeError("aggregate live writers and setup claims reach the configured pool limit")
    for row in direct + native:
        if "ownedPaths" not in row:
            # The shared registry allows older rows without claims. Read their exact retained record.
            old = read_json(record_path(state, row["id"]))
            if old.get("identity") != row["identity"]:
                raise RuntimeError("live writer has unavailable path ownership: " + row["id"])
            row = dict(row, ownedPaths=old["ownedPaths"])
        for old in row["ownedPaths"]:
            prefix = claim_prefix(old)
            if prefix == "." or any(overlap(path, prefix) for path in claims):
                raise RuntimeError("live source owner overlaps: " + row["id"])
    for row in pending:
        for old in row["ownedPaths"]:
            prefix = claim_prefix(old)
            if prefix == "." or any(overlap(path, prefix) for path in claims):
                raise RuntimeError("preparing source owner overlaps: " + row["id"])
    return {"native": len({process_key(row["identity"]) for row in native}),
            "direct": len({process_key(row["identity"]) for row in direct}),
            "aggregate": len(keys), "pending": len(pending),
            "admission": len(keys) + len(pending), "limit": limit, "observedAt": now()}


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def git(base, *args, **kwargs):
    return run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                "-C", str(base), *args], capture_output=True, **kwargs).stdout.strip()


def completion_route(rec):
    main = Path(rec.get("mainCheckout") or os.environ.get("GOAL_MAIN_CHECKOUT")
                or SELF.parents[3]).resolve()
    helper = main / "tools" / "goal" / "scripts" / "code-only-completion.py"
    runtime = Path(rec.get("completionRuntime") or main / "node_modules" / ".bin" / "bun").resolve()
    return main, helper, runtime


def complete(path, state, rec, retry_source=False):
    main, helper, runtime = completion_route(rec)
    environment = dict(os.environ, GOAL_MAIN_CHECKOUT=str(main), GOAL_STATE_DIRECTORY=str(state))
    command = [sys.executable, str(helper), "--record", str(path), "--main", str(main),
               "--state", str(state), "--bun", str(runtime)]
    if retry_source:
        command.append("--retry-source")
    call = subprocess.run(command, cwd=main, env=environment, text=True, capture_output=True)
    if call.returncode:
        detail = (call.stderr or call.stdout).strip()[-4096:]
        raise RuntimeError("source completion callback failed" + (": " + detail if detail else ""))


def main_checkout(path):
    common = Path(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    return common.parent.resolve()


def resolved_from(root, value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else root / path).resolve()


def settings_paths(args):
    cwd = Path.cwd().resolve()
    configured_main = os.environ.get("GOAL_MAIN_CHECKOUT")
    initial_main = resolved_from(cwd, configured_main) if configured_main else main_checkout(cwd)
    local_value = os.environ.get("GOAL_LOCAL_CONFIG")
    local_path = (resolved_from(cwd, local_value) if local_value
                  else initial_main / ".temp" / "goal" / "local.json")
    local = read_json(local_path)
    main_value = configured_main or local.get("mainCheckout") or initial_main
    main = resolved_from(local_path.parent, main_value)
    state_value = args.state or local.get("stateDirectory") or ".temp/goal"
    state = resolved_from(main, state_value)
    return local, main, state


def configured_pool(local, name):
    pools = local.get("pools")
    if not isinstance(pools, list):
        raise ValueError("local settings require a configured pool list")
    matches = [row for row in pools if isinstance(row, dict) and row.get("name") == name]
    if len(matches) != 1:
        raise ValueError("selected pool is not uniquely configured: " + name)
    pool = matches[0]
    if pool.get("cli") != "codex":
        raise ValueError("selected pool is not a supported Codex pool: " + name)
    policy = pool.get("policy")
    limit = policy.get("maxConcurrent") if isinstance(policy, dict) else None
    if type(limit) is not int or limit <= 0:
        raise ValueError("selected pool requires a positive configured concurrency limit: " + name)
    return pool, limit


def unit_properties(unit):
    output = run(["systemctl", "--user", "show", unit, "--property=MemoryHigh",
                  "--property=MemoryMax", "--property=ControlGroup"], capture_output=True).stdout
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def service_terminal(unit):
    result = subprocess.run(["systemctl", "--user", "show", unit, "--property=LoadState",
                             "--property=ActiveState"], capture_output=True, text=True, check=False)
    properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    # Failure to contact the service manager is unknown, not evidence of terminality.
    return (properties.get("LoadState") == "not-found"
            or (result.returncode == 0 and properties.get("ActiveState") in {"inactive", "failed"}))


def finite_memory_limit(properties, key, unit):
    value = properties.get(key, "")
    if not value.isdigit() or int(value) <= 0:
        raise RuntimeError(unit + " requires a finite configured " + key)
    return int(value)


def memory_safety(state, anchor=False):
    if anchor:
        active = subprocess.run(["systemctl", "--user", "is-active", "--quiet",
                                 "rezics-code-only-budget.service"], check=False)
        if active.returncode:
            run(["systemd-run", "--user", "--quiet", "--unit=rezics-code-only-budget",
                 "--remain-after-exit", "--property=Type=oneshot", "--slice=" + SLICE,
                 "/usr/bin/true"], capture_output=True)
    direct, safety = unit_properties(SLICE), unit_properties(SAFETY_SLICE)
    direct_max = finite_memory_limit(direct, "MemoryMax", SLICE)
    direct_high = finite_memory_limit(direct, "MemoryHigh", SLICE)
    safety_max = finite_memory_limit(safety, "MemoryMax", SAFETY_SLICE)
    if direct_high > direct_max:
        raise RuntimeError("configured code-only MemoryHigh exceeds MemoryMax")
    parent = Path("/sys/fs/cgroup") / safety["ControlGroup"].lstrip("/")
    child = Path("/sys/fs/cgroup") / direct["ControlGroup"].lstrip("/")
    if not safety["ControlGroup"] or parent not in child.parents:
        raise RuntimeError("code-only slice must share the existing rezics.slice safety ceiling")
    memory = dict(re.findall(r"^(MemTotal|MemAvailable):\s+(\d+) kB$",
                             Path("/proc/meminfo").read_text(), re.MULTILINE))
    capacity_path = state / "capacity.json"
    floor = read_json(capacity_path).get("minAvailableMiB", 0) if capacity_path.exists() else 0
    if not isinstance(floor, (int, float)) or not math.isfinite(floor) or floor < 0:
        raise ValueError("invalid host memory floor")
    headroom = max(4 * GIB, int(floor * 1024 ** 2))
    current = int((parent / "memory.current").read_text())
    direct_current = int((child / "memory.current").read_text())
    if (safety_max + 4 * GIB > int(memory["MemTotal"]) * 1024
            or int(memory["MemAvailable"]) * 1024 < headroom
            or safety_max - current < headroom or direct_current >= direct_high):
        raise RuntimeError("shared host headroom or code-only memory budget is exhausted")
    return {"slice": SLICE, "controlGroup": direct["ControlGroup"],
            "memoryHigh": direct_high, "memoryMax": direct_max,
            "safetyMemoryMax": safety_max, "hostHeadroomBytes": headroom}


def window(value):
    until = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if until.tzinfo is None or until <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("--defer-until must name a future explicit code-only window with a timezone")
    return until.isoformat()


def prepare_worktree(rec):
    base, tree = Path(rec["sourceCheckout"]), Path(rec["worktree"])
    if tree.exists() or tree.is_symlink():
        raise RuntimeError("refusing to reuse an existing worktree")
    tree.parent.mkdir(parents=True, exist_ok=True)
    for claim in rec["ownedPaths"]:
        current = base
        for part in PurePosixPath(claim).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("source claims cannot follow symlinks: " + claim)
    # Worktrees share Git objects. No copy, install, checkout of the full tree, or source symlink writes.
    git(base, "worktree", "add", "--no-checkout", "-b", rec["branch"], str(tree), rec["baseCommit"])
    neighborhoods = sorted({path if (base / path).is_dir() else str(PurePosixPath(path).parent)
                            for path in rec["ownedPaths"]} - {"."})
    git(tree, "sparse-checkout", "init", "--cone")
    # Root files are already included by cone mode; selecting '.' would expand the entire tree.
    # --skip-checks permits neighborhoods for source directories that this assignment will create.
    git(tree, "sparse-checkout", "set", "--skip-checks", "--stdin",
        input="".join(path + "\n" for path in neighborhoods))
    git(tree, "reset", "--hard", rec["baseCommit"])
    rec["sparseDirectories"] = neighborhoods


def systemd_command(arguments):
    # ':' disables systemd's environment expansion; '%' still needs specifier escaping.
    return ":" + " ".join('"' + value.replace("\\", "\\\\").replace('"', '\\"')
                          .replace("%", "%%") + '"' for value in arguments)


def launch(args):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,70}", args.name):
        raise ValueError("name must be a short lower-case slug")
    local, main, state = settings_paths(args)
    base = Path(git(Path(args.base).expanduser().resolve(), "rev-parse", "--show-toplevel"))
    base = base.resolve()
    claims, until = owned_paths(args.path), window(args.defer_until)
    brief = Path(args.brief).resolve().read_text()
    pool, pool_limit = configured_pool(local, args.pool)
    command = Path(pool["command"]).expanduser()
    configuration = Path(pool["configDirectory"]).expanduser()
    if (not command.is_absolute() or not configuration.is_absolute()
            or not os.access(command, os.X_OK) or not configuration.is_dir()):
        raise ValueError(args.pool + " requires an existing absolute executable and config directory")
    name = args.name + "-" + uuid.uuid4().hex[:8]
    root = state / "code-only"
    worktree_value = (args.worktree_root or os.environ.get("GOAL_WORKTREE_ROOT")
                      or local.get("worktreeRoot") or str(base.parent / "code-only"))
    tree_root = resolved_from(main, worktree_value)
    path = record_path(state, name)
    rec = {"schema": 1, "id": name, "mode": "code-only", "manager": args.manager, "goal": args.goal,
           "cli": pool["cli"], "pool": args.pool, "poolLimit": pool_limit,
           "model": args.model, "effort": "max",
           "serviceTier": "default", "state": "preparing", "createdAt": now(),
           "worktree": str(tree_root / name), "branch": "code-only/" + name, "ownedPaths": claims,
           "sourceCheckout": str(base), "mainCheckout": str(main),
           "completionRuntime": str(main / "node_modules" / ".bin" / "bun"),
           "baseCommit": git(base, "rev-parse", "HEAD"),
           "command": str(command.resolve()), "configDirectory": str(configuration.resolve()),
           "home": os.environ["HOME"], "unit": "rezics-code-only-" + name + ".service",
           "logPath": str(root / (name + ".jsonl")), "briefPath": str(root / (name + ".md")),
           "controllerTaskId": None, "deferUntil": until,
           "deferredAcceptance": "Source only; all checks deferred until " + until +
                                 ". Source is not integration or verified admission."}
    with locked(state):
        if path.exists():
            raise RuntimeError("launch ID already exists")
        atomic_json(path, rec)
        try:
            rec["admission"] = admit(state, claims, pool_limit, name)
            rec["memory"] = memory_safety(state, anchor=True)
            Path(rec["briefPath"]).write_text(brief)
            prepare_worktree(rec)
            rec["state"] = "queued"
            atomic_json(path, rec)
        except BaseException as error:
            rec.update(state="failed", endedAt=now(), error=str(error))
            save(state, path, rec)
            raise
    # Do not hold the registry lock while systemd waits for the runner's READY notification.
    stop = systemd_command([sys.executable, str(SELF), "finish", "--record", str(path)])
    try:
        run(["systemd-run", "--user", "--quiet", "--collect", "--unit=" + rec["unit"],
             "--slice=" + SLICE, "--property=Type=notify", "--property=NotifyAccess=main",
             "--property=TimeoutStartSec=60", "--property=TimeoutStopSec=20",
             "--property=KillMode=control-group", "--property=Restart=no", "--property=OOMPolicy=stop",
             "--property=ExecStopPost=" + stop, sys.executable, str(SELF), "run", "--record", str(path)],
            capture_output=True)
    except BaseException as error:
        # An interrupted client can have successfully submitted its service. Keep live ownership intact.
        settle = False
        with locked(state):
            current = read_json(path)
            current["launchError"] = str(error)
            if isinstance(error, subprocess.CalledProcessError):
                current["launchError"] += ": " + (error.stderr or "").strip()
            if (not (current.get("identity") and same_process(current["identity"]))
                    and not (current.get("runnerIdentity") and same_process(current["runnerIdentity"]))
                    and service_terminal(current["unit"])):
                if current["state"] not in TERMINAL:
                    current.update(state="failed", endedAt=now(), exitCode=None)
                # Keep any existing writer row until its source evidence is durable.
                atomic_json(path, current)
                settle = True
            else:
                atomic_json(path, current)
        if settle:
            finish(path)
        raise
    with locked(state):
        current = read_json(path)
        print(json.dumps({key: current.get(key) for key in
                          ("id", "state", "identity", "worktree", "unit", "logPath")} | {"record": str(path)}))


def prompt(rec, path):
    checkpoint = shlex.join([sys.executable, str(SELF), "checkpoint", "--record", str(path)])
    return Path(rec["briefPath"]).read_text() + (
        "\n\nCode-only runtime: all checks are deferred until " + rec["deferUntil"] +
        ". Do not run tests, typechecks, lint, builds, installs or verification commands. "
        "Read only brief-linked source and sections; linked reads can use " + rec["sourceCheckout"] +
        ". Commit coherent source in this isolated sparse worktree; do not deploy or touch native task/check state. "
        "Keep edits in the recorded owned paths. Disable commit hooks with git -c core.hooksPath=/dev/null "
        "during this deferred-check window. After your first edit and after committing, run: " + checkpoint +
        ". This records source separately from a live PID. Report deferred acceptance, related findings and "
        "a useful independent next outcome in your final handoff.\n")


def notify_ready():
    address = os.environ["NOTIFY_SOCKET"]
    if address.startswith("@"):
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.connect(address)
        channel.sendall(b"READY=1")


def interrupted(signum, frame):
    raise InterruptedError("runner received signal " + str(signum))


def writer(value):
    path, state = record_context(value)
    child = None
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        with locked(state):
            rec = read_json(path)
            if rec["state"] != "queued":
                raise RuntimeError("record is not an unused queued launch")
            group = Path("/proc/self/cgroup").read_text().strip()
            expected = rec["memory"]["controlGroup"] + "/" + rec["unit"]
            if (not os.environ.get("NOTIFY_SOCKET") or not os.environ.get("INVOCATION_ID")
                    or "0::" + expected not in group.splitlines()):
                raise RuntimeError("run is internal to the recorded bounded systemd service")
            window(rec["deferUntil"])
            rec["admission"] = admit(state, rec["ownedPaths"], rec["poolLimit"], rec["id"])
            rec["memory"] = memory_safety(state)
            rec.update(runnerIdentity=identity(os.getpid()), serviceInvocation=os.environ["INVOCATION_ID"])
            atomic_json(path, rec)
            environment = dict(os.environ, HOME=rec["home"], CODEX_HOME=rec["configDirectory"],
                               REZICS_CODE_ONLY_RECORD=str(path))
            environment.pop("NOTIFY_SOCKET", None)
            command = [rec["command"], "exec", "--json", "--ignore-user-config", "-m", rec["model"],
                       "-c", 'model_reasoning_effort="max"', "-c", 'service_tier="default"',
                       "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false",
                       "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
                       "--dangerously-bypass-approvals-and-sandbox", "-C", rec["worktree"], "--", "-"]
            text = prompt(rec, path)
            # Exclusive log creation prevents a duplicate runner from replacing original terminal output.
            with Path(rec["logPath"]).open("x") as log:
                child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                         text=True, env=environment, start_new_session=True)
            rec.update(startedAt=now(), identity=identity(child.pid))
            if rec["identity"] is not None and child.poll() is None:
                rec["state"] = "running"
                save(state, path, rec)
            else:
                rec.update(state="finished", endedAt=now(), exitCode=child.wait())
                # The completion callback captures source before removing the writer row.
                atomic_json(path, rec)
            notify_ready()
        if rec["state"] == "running":
            child.communicate(text)
            with locked(state):
                rec = read_json(path)
                rec.update(state="finished", endedAt=now(), exitCode=child.returncode)
                # ExecStopPost will capture source, then remove the exact writer identity.
                atomic_json(path, rec)
        return rec["exitCode"] if rec["exitCode"] >= 0 else 128 - rec["exitCode"]
    except BaseException as error:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        if child is not None:
            # This is our unreaped child handle; never signal a PID found by name or a stale record.
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        with locked(state):
            rec = read_json(path)
            # A rejected duplicate invocation must not fail or unpublish the original live writer.
            if not rec.get("identity") or not same_process(rec["identity"]):
                rec.update(state="interrupted" if isinstance(error, InterruptedError) else "failed",
                           endedAt=now(), error=str(error), exitCode=child.returncode if child else None)
                # The service stop hook owns final capture and registry cleanup.
                atomic_json(path, rec)
        raise


def finish(value, retry_source=False):
    """One-shot ExecStopPost, also safe to invoke for a known record after an interrupted launch."""
    path, state = record_context(value)
    with locked(state):
        rec = read_json(path)
        if rec.get("identity") and same_process(rec["identity"]):
            raise RuntimeError("recorded Codex is still live; ownership retained")
        if rec.get("runnerIdentity") and same_process(rec["runnerIdentity"]):
            raise RuntimeError("recorded runner is still live; ownership retained")
        if "SERVICE_RESULT" not in os.environ and not service_terminal(rec["unit"]):
            raise RuntimeError("service is pending, live or unknown; ownership retained")
        if rec["state"] not in TERMINAL:
            rec.update(state="interrupted", endedAt=now(), exitCode=None)
        if "SERVICE_RESULT" in os.environ or not rec.get("serviceTerminal"):
            rec["serviceTerminal"] = {"observedAt": now(), "result": os.environ.get("SERVICE_RESULT"),
                                      "exitCode": os.environ.get("EXIT_CODE"),
                                      "exitStatus": os.environ.get("EXIT_STATUS")}
        # Persist terminal/service evidence first, without publishing registry cleanup. The callback
        # atomically retains source and handoff before it removes only this original writer identity.
        atomic_json(path, rec)
    complete(path, state, rec, retry_source)


def checkpoint(value):
    path, state = record_context(value)
    with locked(state):
        rec = read_json(path)
        # Source observation is not an admission, a process start, or an acceptance result.
        head = git(rec["worktree"], "rev-parse", "HEAD")
        stat = git(rec["worktree"], "diff", "--stat", "HEAD", "--", *rec["ownedPaths"])
        untracked = git(rec["worktree"], "ls-files", "--others", "--exclude-standard", "--", *rec["ownedPaths"])
        commits = git(rec["worktree"], "log", "--format=%H", rec["baseCommit"] + ".." + head).splitlines()
        observed = now()
        rec["source"] = {"observedAt": observed, "head": head, "diffStat": stat,
                         "untrackedPaths": untracked.splitlines(), "commits": commits}
        if stat or untracked or commits:
            rec.setdefault("firstSourceAt", observed)
        if commits:
            rec.setdefault("firstCommitAt", observed)
        save(state, path, rec)
        print(json.dumps(rec["source"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    start = actions.add_parser("launch")
    start.add_argument("--state", default=os.environ.get("GOAL_STATE_DIRECTORY"))
    for name in ("name", "manager", "goal", "brief", "base", "defer-until"):
        start.add_argument("--" + name, required=True)
    start.add_argument("--pool", required=True)
    start.add_argument("--path", action="append", required=True)
    start.add_argument("--model", default="gpt-6.1-sol")
    start.add_argument("--worktree-root")
    for name in ("run", "finish", "checkpoint"):
        action = actions.add_parser(name)
        action.add_argument("--record", required=True)
        if name == "finish":
            action.add_argument("--retry-source", action="store_true",
                                help="Retry failed source and worker-handoff capture")
    args = parser.parse_args()
    if args.action == "launch":
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, interrupted)
        launch(args)
    elif args.action == "run":
        return writer(args.record)
    elif args.action == "finish":
        finish(args.record, retry_source=args.retry_source)
    else:
        checkpoint(args.record)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
        print("code-only-launch: " + str(error), file=sys.stderr)
        sys.exit(1)
