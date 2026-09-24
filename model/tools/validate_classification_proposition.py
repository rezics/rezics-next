#!/usr/bin/env python3
"""Validate five distinct, linked classification definition focuses with pinned Jena SHACL."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "classification-proposition-v1.ttl"
PROFILE_SHA256 = "8bc799783d7d2c43da737b01d2b1f10bba4dc643716f1ac09524d1ef0e86dbd0"
BASE = "https://rezics.com/definition/classification-proposition-v1"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
SKOS = "http://www.w3.org/2004/02/skos/core#"
RV = "https://rezics.com/vocab/"
SH = "http://www.w3.org/ns/shacl#"


def validate(data, focuses, jena_home, java_home, temp_root):
    if any(not SAFE_IRI.fullmatch(value) for value in focuses.values()):
        raise ValueError("invalid classification definition focus")
    if len(set(focuses.values())) != len(focuses):
        raise ValueError("classification definition focuses must be distinct")
    if data.stat().st_size > 65536:
        raise ValueError("classification candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("classification-proposition-v1 shape digest changed without profile review")
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

    # Explicit targets prevent a missing rdf:type from skipping validation. These
    # request-specific hasValue constraints also bind references to the five foci.
    links = (
        ("concept", SKOS + "inScheme", "scheme"),
        ("path", RV + "terminalConcept", "concept"),
        ("expression", RV + "path", "path"),
        ("expression", RV + "assertedConcept", "concept"),
        ("sense", RV + "path", "path"),
        ("sense", RV + "expression", "expression"),
    )
    dynamic = "".join(
        f"\n<{BASE}/{role}-shape> <{SH}targetNode> <{value}> ."
        for role, value in focuses.items()
    ) + "".join(
        f"\n<{BASE}/{source}-shape> <{SH}property> "
        f"[ <{SH}path> <{predicate}> ; <{SH}hasValue> <{focuses[target]}> ] ."
        for source, predicate, target in links
    )
    with tempfile.TemporaryDirectory(prefix="classification-shape-", dir=temp_root) as dirname:
        shape_file = Path(dirname) / "shapes.ttl"
        shape_file.write_bytes(shapes + dynamic.encode())
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
    return {"profile": "classification-proposition-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "focuses": focuses, "conforms": conforms,
            "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    for role in ("scheme", "concept", "path", "expression", "sense"):
        parser.add_argument(f"--{role}", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    focuses = {role: getattr(args, role) for role in
               ("scheme", "concept", "path", "expression", "sense")}
    report = validate(args.data.resolve(strict=True), focuses,
                      args.jena_home.resolve(strict=True),
                      args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
