"""Run a small Access semantics probe in a fresh, temporary PostgreSQL cluster.

Requires PostgreSQL 18 tools on PATH. No existing instance is contacted; the
temporary server listens only on its own Unix socket and is stopped on exit.
This checks illustrative semantics, not performance or production authorization.
"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

TOOLS = {name: shutil.which(name) for name in ("postgres", "initdb", "psql", "pg_ctl")}
if not all(TOOLS.values()):
    raise SystemExit("PostgreSQL server/client tools are required on PATH")
version = subprocess.check_output([TOOLS["postgres"], "--version"], text=True).strip()
if not version.startswith("postgres (PostgreSQL) 18."):
    raise SystemExit(f"This probe targets PostgreSQL 18; received {version}")
root = Path(tempfile.mkdtemp(prefix="rezics-access-probe-"))
data = root / "data"
sockets = root / "socket"
sockets.mkdir(mode=0o700)
subprocess.run(
    [TOOLS["initdb"], "-D", str(data), "--username=probe", "--no-locale",
     "--encoding=UTF8", "--auth-local=trust", "--auth-host=reject"],
    check=True, capture_output=True, text=True, timeout=30,
)
client = [TOOLS["psql"], "-X", "-h", str(sockets), "-p", "55432",
          "-U", "probe", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
log = (root / "server.log").open("w")
server = subprocess.Popen(
    [TOOLS["postgres"], "-D", str(data), "-k", str(sockets), "-p", "55432",
     "-c", "listen_addresses=", "-c", "fsync=on", "-c", "synchronous_commit=on"],
    stdout=log, stderr=subprocess.STDOUT,
)
try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError((root / "server.log").read_text())
        ready = subprocess.run(client + ["-Atc", "SELECT 1"], capture_output=True, timeout=2)
        if ready.returncode == 0:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("Temporary PostgreSQL did not become ready")
    result = subprocess.run(
        client + ["-f", str(Path(__file__).with_suffix(".sql"))],
        capture_output=True, text=True, timeout=30,
    )
    (root / "stdout.log").write_text(result.stdout)
    (root / "stderr.log").write_text(result.stderr)
    result.check_returncode()
    checks = [line.split("PASS ", 1)[1] for line in result.stderr.splitlines() if "PASS " in line]
    report = {"version": version, "checks": checks, "passed": len(checks),
              "scope": "illustrative semantics; no load, engine comparison, or product acceptance"}
    (root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print("Evidence directory:", root)
finally:
    if server.poll() is None:
        subprocess.run([TOOLS["pg_ctl"], "-D", str(data), "stop", "-m", "fast", "-w", "-t", "10"],
                       capture_output=True, timeout=15)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.terminate()
            server.wait(timeout=5)
    log.close()
