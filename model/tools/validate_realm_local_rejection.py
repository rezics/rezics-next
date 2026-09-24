#!/usr/bin/env python3
"""Validate one bounded Realm-local rejection candidate with pinned Jena SHACL."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "realm-local-rejection-v1.ttl"
SHAPE = "https://rezics.com/definition/realm-local-rejection-v1/rejection-shape"
PROFILE_SHA256 = "8db4a0124cf3b2ac61a28595fb05677e8dff8977c4b0a126740f583de6589e02"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")


def validate(data, rejection, jena_home, java_home, temp_root):
    if not SAFE_IRI.fullmatch(rejection):
        raise ValueError("invalid Rejection focus")
    if data.stat().st_size > 65536:
        raise ValueError("Rejection candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("realm-local-rejection-v1 shape digest changed without profile review")
    env = os.environ.copy()
    env["JAVA_HOME"] = str(java_home)
    java = subprocess.check_output([str(java_home / "bin" / "java"), "-version"],
                                   stderr=subprocess.STDOUT, text=True)
    if 'version "21.' not in java:
        raise ValueError("this profile is pinned to Java 21")
    version = subprocess.check_output([str(jena_home / "bin" / "shacl"), "--version"],
                                      env=env, stderr=subprocess.STDOUT, text=True).strip()
    if version != "Apache Jena SHACL version 6.2.0":
        raise ValueError(f"unexpected Jena SHACL build: {version}")
    with tempfile.TemporaryDirectory(prefix="rejection-shape-", dir=temp_root) as dirname:
        shape_file = Path(dirname) / "shapes.ttl"
        shape_file.write_bytes(shapes +
            f"\n<{SHAPE}> <http://www.w3.org/ns/shacl#targetNode> <{rejection}> .\n".encode())
        completed = subprocess.run([str(jena_home / "bin" / "shacl"), "validate",
                                    "--shapes", str(shape_file), "--data", str(data)],
                                   env=env, capture_output=True, text=True, timeout=20)
    if completed.returncode != 0:
        raise RuntimeError(f"Jena SHACL failed: {completed.stderr or completed.stdout}")
    matches = re.findall(r"\bsh:conforms\s+(true|false)\b", completed.stdout)
    if "sh:ValidationReport" not in completed.stdout or len(matches) != 1:
        raise RuntimeError(f"Unexpected Jena SHACL report: {completed.stdout}")
    conforms = matches[0] == "true"
    if not conforms and ("sh:result" not in completed.stdout or
                         "sh:focusNode" not in completed.stdout):
        raise RuntimeError(f"Incomplete Jena SHACL violation report: {completed.stdout}")
    return {"profile": "realm-local-rejection-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "rejection_focus": rejection,
            "conforms": conforms, "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--rejection", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    report = validate(args.data.resolve(strict=True), args.rejection,
                      args.jena_home.resolve(strict=True),
                      args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
