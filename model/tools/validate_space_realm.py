#!/usr/bin/env python3
"""Validate a Space and its Realm capability with pinned Jena SHACL."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "space-realm-v1.ttl"
PROFILE_SHA256 = "bae6d586c9dee595adee14a30d05afe20188c73bcf1c33906c823f87ec08b86f"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
BASE = "https://rezics.com/definition/space-realm-v1"


def validate(data, space, realm, jena_home, java_home, temp_root):
    if not SAFE_IRI.fullmatch(space) or not SAFE_IRI.fullmatch(realm) or space == realm:
        raise ValueError("invalid Space or Realm focus")
    if data.stat().st_size > 65536:
        raise ValueError("Space candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("space-realm-v1 shape digest changed without profile review")
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
    with tempfile.TemporaryDirectory(prefix="space-shape-", dir=temp_root) as dirname:
        shape_file = Path(dirname) / "shapes.ttl"
        shape_file.write_bytes(shapes +
            f"\n<{BASE}/space-shape> <http://www.w3.org/ns/shacl#targetNode> <{space}> .\n"
            f"<{BASE}/realm-shape> <http://www.w3.org/ns/shacl#targetNode> <{realm}> .\n".encode())
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
    return {"profile": "space-realm-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "space_focus": space, "realm_focus": realm,
            "conforms": conforms, "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--space", required=True)
    parser.add_argument("--realm", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    report = validate(args.data.resolve(strict=True), args.space, args.realm,
                      args.jena_home.resolve(strict=True), args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
