import hashlib
import json
import pathlib
import re
import subprocess
import xml.etree.ElementTree as ET

root = pathlib.Path.cwd()
out = root / '.temp/goal'
receipt = json.loads((root / '.temp/ref/current-main-receipt.json').read_text())
handoff = json.loads((root / '.temp/ref/handoff.json').read_text())
retained = pathlib.Path('/home/edge/projects/rezics/rezics-next/.temp/goal-orchestration/runs/G-2765/continuity-41-disposition')
sha = lambda data: hashlib.sha256(data).hexdigest()
git = lambda *args: subprocess.check_output(['git', *args])
patch = (root / '.temp/ref/producer.patch').read_bytes()
assert sha(patch) == handoff['patchSha256']
sections = re.split(r'(?=^diff --git )', patch.decode(), flags=re.M)[1:]
pins = []
for section in sections:
    path = section.splitlines()[0].split(' b/', 1)[1]
    old = subprocess.run(['git', 'show', handoff['base'] + ':' + path], capture_output=True)
    baseline = old.stdout.decode().splitlines(keepends=True) if old.returncode == 0 else []
    result, consumed = [], 0
    lines = section.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', lines[i])
        if not match:
            i += 1
            continue
        old_start = int(match[1]) - (int(match[1]) > 0)
        result += baseline[consumed:old_start]
        consumed = old_start
        i += 1
        while i < len(lines) and not lines[i].startswith('@@ '):
            line = lines[i]
            if line.startswith((' ', '-')):
                assert consumed < len(baseline) and baseline[consumed] == line[1:], (path, consumed, line)
                consumed += 1
            if line.startswith((' ', '+')):
                result.append(line[1:])
            i += 1
    result += baseline[consumed:]
    reconstructed = ''.join(result).encode()
    assert sha(reconstructed) == handoff['files'][path], path
    current = (root / path).read_bytes()
    landing = git('show', receipt['sourceLanding'] + ':' + path)
    pins.append({'path': path, 'baseBlob': git('rev-parse', handoff['base'] + ':' + path).decode().strip() if baseline else None,
                 'candidateBlobFromExactPatch': hashlib.sha1(b'blob ' + str(len(reconstructed)).encode() + b'\0' + reconstructed).hexdigest(),
                 'candidateSha256': sha(reconstructed), 'checkoutBlob': git('hash-object', path).decode().strip(),
                 'checkoutSha256': sha(current), 'landingSha256': sha(landing),
                 'authoredEqual': current == reconstructed == landing if path != 'generated/openapi/main/public.json' else None,
                 'matchesCurrentReceipt': sha(current) == next(f['current'] for f in receipt['files'] if f['path'] == path)})
assert all(p['authoredEqual'] for p in pins if p['authoredEqual'] is not None)
assert all(p['matchesCurrentReceipt'] for p in pins)
jobs = []
for item in handoff['recordedJobReceipts']:
    actual = sha((retained / 'handoff' / item['path']).read_bytes())
    assert actual == item['sha256'], item['path']
    jobs.append({**item, 'verified': True})
qa = []
for item in handoff['qa']:
    directory = retained / 'handoff/qa' / item['id']
    xml = directory / 'owner.xml'
    tree = ET.fromstring(xml.read_bytes())
    qa.append({'id': item['id'], 'xmlSha256': sha(xml.read_bytes()), 'header': tree.attrib,
               'actualCases': len(tree.findall('.//testcase')), 'failureElements': len(tree.findall('.//failure')),
               'skippedElements': len(tree.findall('.//skipped')),
               'failures': [{'case': case.attrib, 'failure': failure.text}
                            for case in tree.findall('.//testcase') for failure in case.findall('./failure')]})
lint_path = retained / 'current-qualified-lint.json'
lint = json.loads(lint_path.read_text())
lint_pins = {path: {'checkoutSha256': sha((root / path).read_bytes()), **value}
             for path, value in lint['baselinePaths'].items()}
result = {'reviewedHead': git('rev-parse', 'HEAD').decode().strip(), 'base': handoff['base'], 'candidate': handoff['head'],
          'candidateCommitObjectPresent': subprocess.run(['git', 'cat-file', '-e', handoff['head'] + '^{commit}'], capture_output=True).returncode == 0,
          'candidateReconstruction': 'Every exact retained patch hunk applied in memory to the base blob, with removed/context bytes checked and all 18 reconstructed SHA256s matched to the manifest. No historical ancestry or generated file was imported.',
          'patchSha256': sha(patch), 'sourceLanding': receipt['sourceLanding'], 'files': pins, 'retainedJobs': jobs, 'retainedQa': qa,
          'currentLint': {'receiptSha256': sha(lint_path.read_bytes()), 'receipt': lint, 'checkoutBaselinePins': lint_pins}}
(out / 'keyword-excerpt-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'authoredPinsVerified': 17, 'patchFilesReconstructed': len(pins), 'retainedJobReceiptsVerified': len(jobs),
                  'finalQa': qa[-1], 'currentLintExitCode': lint['exitCode']}, indent=2))
