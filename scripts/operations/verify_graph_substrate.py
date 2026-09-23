#!/usr/bin/env python3
"""Exercise OPS14 and the graph-substrate portion of OPS16 against real Fuseki.

The input directory must be new and disposable. No product data is admitted here.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


LABEL = "REZICS launch atlas"
SUBJECT = "urn:rezics:smoke:book"
GRAPH = "urn:rezics:smoke"
FUSEKI_620_SHA512 = "ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132"
PREFIXES = """PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX text: <http://jena.apache.org/text#>
"""


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port, kind, body):
    endpoint = "update" if kind == "application/sparql-update" else "query"
    req = Request(
        f"http://127.0.0.1:{port}/rezics/{endpoint}",
        data=body.encode(),
        headers={"Content-Type": kind, "Accept": "application/sparql-results+json"},
        method="POST",
    )
    with urlopen(req, timeout=10) as response:
        payload = response.read()
        if kind == "application/sparql-update":
            return response.status
        return json.loads(payload)


def query(port, body):
    return request(port, "application/sparql-query", PREFIXES + body)


def update(port, body):
    status = request(port, "application/sparql-update", PREFIXES + body)
    assert status in (200, 204), status


def bindings(result):
    return result["results"]["bindings"]


def check_present(port):
    graph = bindings(query(port, f"SELECT ?s ?label WHERE {{ GRAPH <{GRAPH}> {{ ?s rdfs:label ?label }} }}"))
    assert len(graph) == 1, graph
    assert graph[0]["s"]["value"] == SUBJECT, graph
    assert graph[0]["label"]["value"] == LABEL, graph
    assert graph[0]["label"]["xml:lang"] == "en", graph
    matched = bindings(query(port, f'''SELECT ?s ?score ?literal WHERE {{
      GRAPH <{GRAPH}> {{
        (?s ?score ?literal) text:query (rdfs:label "atlas" 10) .
        ?s rdfs:label ?literal .
      }}
    }}'''))
    assert len(matched) == 1, matched
    assert matched[0]["s"]["value"] == SUBJECT, matched
    assert matched[0]["literal"]["value"] == LABEL, matched
    return {"graph_bindings": len(graph), "joined_text_bindings": len(matched)}


def check_deleted(port):
    graph = bindings(query(port, f"SELECT ?s WHERE {{ GRAPH <{GRAPH}> {{ ?s rdfs:label ?label }} }}"))
    assert graph == [], graph
    anchor = query(port, f"ASK {{ GRAPH <{GRAPH}> {{ <{SUBJECT}> <urn:rezics:smoke:probeAnchor> true }} }}")
    assert anchor["boolean"] is True, anchor
    direct = bindings(query(port, f'''SELECT ?score ?literal WHERE {{
      GRAPH <{GRAPH}> {{
        (<{SUBJECT}> ?score ?literal) text:query (rdfs:label "atlas") .
      }}
    }}'''))
    assert direct == [], direct
    return {"remaining_labels": len(graph), "anchor_retained": True, "direct_text_bindings": len(direct)}


def start(fuseki_home, java_home, base, port, log_path):
    log = log_path.open("ab")
    env = os.environ.copy()
    env.update({
        "JAVA_HOME": str(java_home),
        "FUSEKI_HOME": str(fuseki_home),
        "FUSEKI_BASE": str(base),
        "MAIN": "main",
        "JVM_ARGS": "-Xms128m -Xmx1g",
    })
    proc = subprocess.Popen(
        [str(fuseki_home / "fuseki-server"), "--localhost", f"--port={port}",
         "--no-cors", "--timeout=10000", f"--config={base / 'fuseki-text.ttl'}"],
        cwd=base, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    log.close()
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"Fuseki exited {proc.returncode}; inspect {log_path}")
        try:
            if query(port, "ASK { GRAPH <urn:rezics:smoke> { ?s ?p ?o } }")["boolean"] in (True, False):
                return proc
        except (URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            pass
        time.sleep(0.25)
    proc.terminate()
    raise TimeoutError(f"Fuseki startup exceeded 45 seconds; inspect {log_path}")


def stop(proc):
    proc.terminate()
    try:
        code = proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError("Fuseki did not stop gracefully")
    assert code in (0, 143), code


def sha512(path):
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fuseki-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--assembler", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True, help="new disposable output directory")
    parser.add_argument("--fuseki-archive", type=Path, required=True)
    args = parser.parse_args()
    assert not args.state.exists(), f"Refusing to reuse {args.state}"
    fuseki_home = args.fuseki_home.resolve(strict=True)
    java_home = args.java_home.resolve(strict=True)
    assembler = args.assembler.resolve(strict=True)
    archive = args.fuseki_archive.resolve(strict=True)
    state = args.state.resolve()
    live = state / "live" / "run"
    live.mkdir(parents=True, mode=0o700)
    (live / "databases" / "rezics" / "tdb2").mkdir(parents=True)
    (live / "databases" / "rezics" / "lucene").mkdir(parents=True)
    shutil.copyfile(assembler, live / "fuseki-text.ttl")
    java_version = subprocess.check_output([str(java_home / "bin" / "java"), "-version"], stderr=subprocess.STDOUT, text=True)
    assert 'version "21.' in java_version, java_version
    archive_hash = sha512(archive)
    assert archive_hash == FUSEKI_620_SHA512, "Fuseki 6.2.0 archive checksum mismatch"
    evidence = {
        "cases": ["OPS14", "OPS16-substrate"],
        "java": java_version.splitlines()[0],
        "fuseki_archive_sha512": archive_hash,
        "assembler_sha512": sha512(assembler),
        "checks": {},
    }
    proc = None
    try:
        port = free_port()
        proc = start(fuseki_home, java_home, live, port, state / "live.log")
        update(port, f'''INSERT DATA {{ GRAPH <{GRAPH}> {{
          <{SUBJECT}> rdfs:label "{LABEL}"@en ;
            <urn:rezics:smoke:probeAnchor> true .
        }} }}''')
        evidence["checks"]["insert"] = check_present(port)
        stop(proc)
        proc = None

        port = free_port()
        proc = start(fuseki_home, java_home, live, port, state / "restart.log")
        evidence["checks"]["restart"] = check_present(port)
        stop(proc)
        proc = None

        backup = state / "graph-backup.tar.gz"
        subprocess.run(["tar", "-czf", str(backup), "-C", str(live.parent), "run"], check=True)
        evidence["backup_sha512"] = sha512(backup)
        restore = state / "restore"
        restore.mkdir()
        subprocess.run(["tar", "-xzf", str(backup), "-C", str(restore)], check=True)
        assert sha512(backup) == evidence["backup_sha512"]
        restored_base = restore / "run"
        assert restored_base.resolve() != live.resolve()
        port = free_port()
        proc = start(fuseki_home, java_home, restored_base, port, state / "restore.log")
        evidence["checks"]["isolated_restore"] = check_present(port)
        update(port, f'''DELETE DATA {{ GRAPH <{GRAPH}> {{
          <{SUBJECT}> rdfs:label "{LABEL}"@en .
        }} }}''')
        evidence["checks"]["delete"] = check_deleted(port)
        update(port, f"DROP SILENT GRAPH <{GRAPH}>")
        stop(proc)
        proc = None
        evidence["result"] = "pass"
    finally:
        if proc is not None and proc.poll() is None:
            stop(proc)
        (state / "result.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
