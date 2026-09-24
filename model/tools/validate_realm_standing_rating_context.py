#!/usr/bin/env python3
"""Validate the explicit Realm and standing RatingContext focuses."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "realm-standing-rating-context-v1.ttl"
PROFILE_SHA256 = "be1cfde2f3f0c6207e684829b7a5a9c66383f52a640908051cd245ebf0454cd9"
BASE = "https://rezics.com/definition/realm-standing-rating-context-v1"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
RV = "https://rezics.com/vocab/"
SH = "http://www.w3.org/ns/shacl#"


def validate(data, realm, context, question, jena_home, java_home, temp_root):
    if not SAFE_IRI.fullmatch(realm) or not SAFE_IRI.fullmatch(context) or realm == context:
        raise ValueError("Realm and rating context must have distinct native IDs")
    if (not 3 <= len(question) <= 120 or question != unicodedata.normalize("NFC", question)
            or any(ord(char) < 32 or ord(char) == 127 for char in question)):
        raise ValueError("rating question must be normalized, printable and 3–120 characters")
    if data.stat().st_size > 65536:
        raise ValueError("rating context candidate exceeds 64 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("realm-standing-rating-context-v1 shape digest changed without profile review")
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
    question_literal = json.dumps(question, ensure_ascii=False) + "@en"
    dynamic = (
        f"\n<{BASE}/realm-shape> <{SH}targetNode> <{realm}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}ratingContext> ; <{SH}hasValue> <{context}> ] ."
        f"\n<{BASE}/context-shape> <{SH}targetNode> <{context}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}realm> ; <{SH}hasValue> <{realm}> ] ; <{SH}property> "
        f"[ <{SH}path> <{RV}question> ; <{SH}hasValue> {question_literal} ] ."
    )
    with tempfile.TemporaryDirectory(prefix="rating-context-shape-", dir=temp_root) as dirname:
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
    return {"profile": "realm-standing-rating-context-v1", "profile_sha256": PROFILE_SHA256,
            "jena_shacl": version, "realm_focus": realm, "context_focus": context,
            "conforms": conforms, "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--realm", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    report = validate(args.data.resolve(strict=True), args.realm, args.context, args.question,
                      args.jena_home.resolve(strict=True),
                      args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
