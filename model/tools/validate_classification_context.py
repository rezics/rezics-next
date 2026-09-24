#!/usr/bin/env python3
"""Validate the fixed Global and distinct Realm classification context focuses."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "classification-context-v1.ttl"
PROFILE_SHA256 = "41aa65a8f1f780d5902b858a8e9238d7e932afc88add4b23d731c51cfcd0bd20"
BASE = "https://rezics.com/definition/classification-context-v1"
GLOBAL = "urn:rezics:classification-context:global"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
RV = "https://rezics.com/vocab/"
SH = "http://www.w3.org/ns/shacl#"


def validate(data, realm, context, jena_home, java_home, temp_root):
    if not SAFE_IRI.fullmatch(realm) or not SAFE_IRI.fullmatch(context) or realm == context:
        raise ValueError("Realm and classification context must have distinct native IDs")
    if data.stat().st_size > 65536:
        raise ValueError("classification context candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("classification-context-v1 shape digest changed without profile review")
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
    dynamic = (
        f"\n<{BASE}/global-shape> <{SH}targetNode> <{GLOBAL}> ."
        f"\n<{BASE}/realm-shape> <{SH}targetNode> <{realm}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}classificationContext> ; <{SH}hasValue> <{context}> ] ."
        f"\n<{BASE}/context-shape> <{SH}targetNode> <{context}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}realm> ; <{SH}hasValue> <{realm}> ] ."
    )
    with tempfile.TemporaryDirectory(prefix="classification-context-shape-", dir=temp_root) as dirname:
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
    return {"profile": "classification-context-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "global_focus": GLOBAL, "realm_focus": realm,
            "context_focus": context, "conforms": conforms,
            "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--realm", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    report = validate(args.data.resolve(strict=True), args.realm, args.context,
                      args.jena_home.resolve(strict=True),
                      args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
