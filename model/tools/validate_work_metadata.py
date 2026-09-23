#!/usr/bin/env python3
"""Validate one bounded Work/MainVersion candidate with Jena SHACL 6.2.0.

This is a profile helper, not an admission or graph mutation endpoint. Main must
later supply a coherent candidate and guard every mutable validation dependency.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "work-metadata-v1.ttl"
WORK_SHAPE = "https://rezics.com/definition/work-metadata-v1/work-shape"
MAIN_SHAPE = "https://rezics.com/definition/work-metadata-v1/main-version-shape"
PROFILE_SHA256 = "f0c4443ef63c3ff56a52217533c2c642c5076f923cbaf6db33bf49dc78ef3907"
SAFE_IRI = re.compile(r"^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$")


def iri(value):
    if not SAFE_IRI.fullmatch(value):
        raise ValueError("focus must be an absolute HTTPS IRI without RDF syntax")
    return f"<{value}>"


def validate(data, work, main, jena_home, java_home, temp_root):
    if work == main:
        raise ValueError("Work and MainVersion must have distinct identities")
    if data.stat().st_size > 65536:
        raise ValueError("work candidate exceeds the fixed profile's 64 KiB budget")
    shape_bytes = PROFILE.read_bytes()
    assert shape_bytes.count(b"a sh:NodeShape") == 2, "expected exactly two required shapes"
    if hashlib.sha256(shape_bytes).hexdigest() != PROFILE_SHA256:
        raise ValueError("work-metadata-v1 shape digest changed without profile review")
    java_version = subprocess.check_output([str(java_home / "bin" / "java"), "-version"], stderr=subprocess.STDOUT, text=True)
    if 'version "21.' not in java_version:
        raise ValueError("this profile is pinned to Java 21")
    env = os.environ.copy()
    env["JAVA_HOME"] = str(java_home)
    jena_version = subprocess.check_output([str(jena_home / "bin" / "shacl"), "--version"], env=env, stderr=subprocess.STDOUT, text=True).strip()
    if jena_version != "Apache Jena SHACL version 6.2.0":
        raise ValueError(f"unexpected Jena SHACL build: {jena_version}")
    with tempfile.TemporaryDirectory(prefix="work-shape-", dir=temp_root) as dirname:
        shapes = Path(dirname) / "shapes.ttl"
        shapes.write_bytes(shape_bytes + f"\n<{WORK_SHAPE}> <http://www.w3.org/ns/shacl#targetNode> {iri(work)} .\n<{MAIN_SHAPE}> <http://www.w3.org/ns/shacl#targetNode> {iri(main)} .\n".encode())
        completed = subprocess.run(
            [str(jena_home / "bin" / "shacl"), "validate", "--shapes", str(shapes),
             "--data", str(data)],
            env=env, capture_output=True, text=True, timeout=20,
        )
    if completed.returncode != 0:
        raise RuntimeError(f"Jena SHACL failed: {completed.stderr or completed.stdout}")
    matches = re.findall(r"\bsh:conforms\s+(true|false)\b", completed.stdout)
    if "sh:ValidationReport" not in completed.stdout or len(matches) != 1:
        raise RuntimeError(f"Unexpected Jena SHACL report: {completed.stdout}")
    conforms = matches[0] == "true"
    if not conforms and ("sh:result" not in completed.stdout or "sh:focusNode" not in completed.stdout):
        raise RuntimeError(f"Incomplete Jena SHACL violation report: {completed.stdout}")
    return {
        "profile": "work-metadata-v1",
        "profile_sha256": PROFILE_SHA256,
        "java": java_version.splitlines()[0],
        "jena_shacl": jena_version,
        "work_focus": work,
        "main_focus": main,
        "conforms": conforms,
        "report": completed.stdout.strip(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--main", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    result = validate(
        args.data.resolve(strict=True), args.work, args.main,
        args.jena_home.resolve(strict=True), args.java_home.resolve(strict=True),
        args.temp_root.resolve(strict=True),
    )
    print(json.dumps(result, indent=2))
    return 0 if result["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
