#!/usr/bin/env python3
"""Validate explicit standing RatingObservation and revision focuses."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PROFILE = Path(__file__).resolve().parents[1] / "definitions" / "realm-standing-rating-observation-v1.ttl"
PROFILE_SHA256 = "a0206416dfc9d591e187dc22400ac802810a01245adb20e4ff48bdd4360960da"
BASE = "https://rezics.com/definition/realm-standing-rating-observation-v1"
SAFE_IRI = re.compile(r"^https://rezics\.com/id/[0-9a-f-]{36}$")
SLOT_IRI = re.compile(r"^urn:rezics:rating-slot:[0-9a-f]{64}$")
RV = "https://rezics.com/vocab/"
SH = "http://www.w3.org/ns/shacl#"


def validate(data, realm, context, work, main, slot, observation, revision,
             availability, value, predecessor, jena_home, java_home, temp_root):
    identities = [realm, context, work, main, observation, revision]
    if any(not SAFE_IRI.fullmatch(item) for item in identities) or len(set(identities)) != len(identities):
        raise ValueError("rating focuses need distinct native IDs")
    if not SLOT_IRI.fullmatch(slot):
        raise ValueError("rating slot needs an opaque slot URI")
    if predecessor is not None and (not SAFE_IRI.fullmatch(predecessor)
                                    or predecessor in identities):
        raise ValueError("rating predecessor needs a distinct native ID")
    if availability not in ("available", "withdrawn"):
        raise ValueError("rating availability must be available or withdrawn")
    if (availability == "available" and (value is None or not 1 <= value <= 10)) or (
            availability == "withdrawn" and value is not None):
        raise ValueError("rating value does not match availability")
    if data.stat().st_size > 131072:
        raise ValueError("rating observation candidate exceeds 128 KiB")
    shapes = PROFILE.read_bytes()
    if hashlib.sha256(shapes).hexdigest() != PROFILE_SHA256:
        raise ValueError("realm-standing-rating-observation-v1 shape digest changed without profile review")
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
        f"\n<{BASE}/realm-shape> <{SH}targetNode> <{realm}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}ratingContext> ; <{SH}hasValue> <{context}> ] ."
        f"\n<{BASE}/context-shape> <{SH}targetNode> <{context}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}realm> ; <{SH}hasValue> <{realm}> ] ."
        f"\n<{BASE}/work-shape> <{SH}targetNode> <{work}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}mainVersion> ; <{SH}hasValue> <{main}> ] ."
        f"\n<{BASE}/main-shape> <{SH}targetNode> <{main}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}work> ; <{SH}hasValue> <{work}> ] ."
        f"\n<{BASE}/observation-shape> <{SH}targetNode> <{observation}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}ratingContext> ; <{SH}hasValue> <{context}> ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}targetMainVersion> ; <{SH}hasValue> <{main}> ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}ratingSlot> ; <{SH}hasValue> <{slot}> ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}observationHead> ; <{SH}hasValue> <{revision}> ] ."
        f"\n<{BASE}/revision-shape> <{SH}targetNode> <{revision}> ; <{SH}property> "
        f"[ <{SH}path> <{RV}observation> ; <{SH}hasValue> <{observation}> ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}ratingAvailability> ; "
        f"<{SH}hasValue> <{RV}{'Available' if availability == 'available' else 'Withdrawn'}> ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}predecessor> ; "
        + (f"<{SH}hasValue> <{predecessor}>" if predecessor else f"<{SH}maxCount> 0")
        + " ] ; "
        f"<{SH}property> [ <{SH}path> <{RV}ratingValue> ; "
        + (f"<{SH}hasValue> {value}" if value is not None else f"<{SH}maxCount> 0")
        + " ] ."
    )
    with tempfile.TemporaryDirectory(prefix="rating-observation-shape-", dir=temp_root) as dirname:
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
    return {"profile": "realm-standing-rating-observation-v1",
            "profile_sha256": PROFILE_SHA256, "jena_shacl": version,
            "focuses": identities, "slot": slot, "conforms": conforms,
            "report": completed.stdout.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    for name in ("realm", "context", "work", "main", "slot", "observation", "revision"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--availability", choices=("available", "withdrawn"), required=True)
    parser.add_argument("--value", type=int)
    parser.add_argument("--predecessor")
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, default=Path(".temp"))
    args = parser.parse_args()
    args.temp_root.mkdir(exist_ok=True)
    report = validate(args.data.resolve(strict=True), args.realm, args.context,
                      args.work, args.main, args.slot, args.observation, args.revision,
                      args.availability, args.value, args.predecessor,
                      args.jena_home.resolve(strict=True), args.java_home.resolve(strict=True),
                      args.temp_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["conforms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
