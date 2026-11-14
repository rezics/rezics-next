#!/usr/bin/env python3
"""Retain one original code-only launch and deliver its handoff, without changing acceptance.

Rerun with the same configured --main, --state and --record to recover delivery or
registry cleanup. Add --retry-source to retry failed source/log capture explicitly.
This callback has no sweep, launcher or native task/check ownership.
"""

import argparse
import base64
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def source(record):
    result = {'observedAt': now()}
    paths = record['ownedPaths']
    for field, args in (
        ('head', ['rev-parse', 'HEAD']),
        ('diffStat', ['diff', '--stat', 'HEAD', '--', *paths]),
        ('trackedDiff', ['diff', '--binary', '--full-index', 'HEAD', '--', *paths]),
        ('untrackedPaths', ['ls-files', '--others', '--exclude-standard', '-z', '--', *paths]),
    ):
        if not paths and field != 'head':
            result[field] = [] if field == 'untrackedPaths' else ''
            continue
        try:
            call = subprocess.run(['git', '-C', record['worktree'], *args], capture_output=True,
                                  text=True, encoding='utf-8', errors='surrogateescape')
            if call.returncode:
                result.setdefault('errors', {})[field] = call.stderr.strip() or f'git exit {call.returncode}'
            else:
                if field == 'untrackedPaths':
                    result[field] = [p for p in call.stdout.split('\0') if p]
                else:
                    result[field] = call.stdout if field == 'trackedDiff' else call.stdout.rstrip('\n')
        except OSError as error:
            result.setdefault('errors', {})[field] = str(error)
    # A commit and tracked patch do not contain untracked files. Keep their bytes separately.
    result['untrackedFiles'] = {}
    for name in result.get('untrackedPaths', []):
        try:
            path = Path(record['worktree']) / name
            if path.is_symlink():
                entry = {'symlink': os.readlink(path)}
            else:
                entry = {'encoding': 'base64', 'data': base64.b64encode(path.read_bytes()).decode('ascii'),
                         'mode': path.stat().st_mode & 0o777}
            result['untrackedFiles'][name] = entry
        except OSError as error:
            result.setdefault('errors', {})['untracked:' + name] = str(error)
    return result


def process_alive(record):
    expected = record.get('identity')
    if not expected:
        return False
    try:
        fields = Path(f"/proc/{expected['pid']}/stat").read_text().rsplit(')', 1)[1].split()
        actual = {'pid': expected['pid'], 'start': fields[19],
                  'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'group': int(fields[2])}
        return fields[0] not in {'Z', 'X', 'x'} and actual == expected
    except (FileNotFoundError, ProcessLookupError):
        return False


def worker_handoff(record):
    final = ''
    # Read this launch's own event stream, retaining the complete last worker message.
    with Path(record['logPath']).open(encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            item = event.get('item')
            if (event.get('type') == 'item.completed' and isinstance(item, dict)
                    and item.get('type') == 'agent_message'):
                final = item.get('text', '')
    return final


def remove_writing(record, state):
    # Root's shared lock must precede the legacy lock used by already-loaded runners.
    with (state / 'code-only-writers.lock').open('a') as outer:
        fcntl.flock(outer, fcntl.LOCK_EX)
        with (state / 'code-only' / 'writers.lock').open('a') as inner:
            fcntl.flock(inner, fcntl.LOCK_EX)
            path = state / 'code-only-writers.json'
            if not path.exists():
                return
            data = json.loads(path.read_text())
            # A stale callback cannot remove a replacement process sharing the launch label.
            writers = [row for row in data['writers'] if not (
                record.get('identity') and row.get('id') == record['id']
                and row.get('identity') == record['identity']
                and row.get('worktree') == record['worktree'])]
            if writers != data['writers']:
                data['writers'] = writers
                atomic(path, data)


def retain_evidence(completion, record, retry_source):
    # A failed final read must not erase the runner's last separately observed source.
    if 'source' in record:
        completion['sourceCheckpoint'] = record['source']
    previous = completion.get('source')
    if previous is None or (retry_source and previous.get('errors')):
        if previous is not None:
            completion.setdefault('sourceAttempts', []).append(previous)
        try:
            completion['source'] = source(record)
        except Exception as error:
            completion['source'] = {'observedAt': now(), 'errors': {'capture': str(error)}}
    if 'finalHandoff' not in completion or (retry_source and completion.get('handoffError')):
        try:
            completion['finalHandoff'] = worker_handoff(record)
            completion.pop('handoffError', None)
        except (OSError, KeyError) as error:
            completion.setdefault('finalHandoff', '')
            completion['handoffError'] = {'observedAt': now(), 'cause': str(error)}
    if 'nextOutcomeProposal' in record:
        completion['nextOutcomeProposal'] = record['nextOutcomeProposal']
    execution = completion.setdefault('execution', {})
    # Service exit belongs to the runner, not necessarily to its original source writer.
    # Preserve only observed execution/cancellation fields; absence grants no authorization.
    execution.update({key: record[key] for key in (
        'state', 'identity', 'startedAt', 'endedAt', 'exitCode', 'error',
        'cancelled', 'cancelledAt', 'cancelReason', 'cancellation',
    ) if key in record})
    service = {key: os.environ[key] for key in ('SERVICE_RESULT', 'EXIT_CODE', 'EXIT_STATUS') if key in os.environ}
    if service:
        execution.setdefault('service', {}).update(service)
    execution['observedAt'] = now()


def finish(path, *, main, state, bun=None, retry_source=False):
    path, main, state = Path(path).resolve(), Path(main).resolve(), Path(state).resolve()
    record = json.loads(path.read_text())
    completions = state / 'code-only' / 'completions'
    completions.mkdir(parents=True, exist_ok=True)
    target = completions / (record['id'] + '.json')
    with (completions / (record['id'] + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = json.loads(path.read_text())
        # A parent exit or stale runner state alone cannot end the original process.
        if process_alive(record):
            return {'id': record['id'], 'state': 'still-writing'}
        completion = json.loads(target.read_text()) if target.exists() else {
            'version': 1, 'id': record['id'], 'manager': record['manager'], 'goal': record['goal'],
            'recordPath': str(path), 'worktree': record['worktree'], 'branch': record.get('branch'),
            'baseCommit': record.get('baseCommit'), 'ownedPaths': record['ownedPaths'],
            'identity': record.get('identity'), 'observedAt': now(),
            'nextOutcomeProposal': record.get('nextOutcomeProposal'),
            'acceptance': 'Deferred. This is retained source and a worker handoff, not accepted output.',
        }
        retain_evidence(completion, record, retry_source)
        # Evidence survives even if cleanup, the native helper or this callback is interrupted.
        atomic(target, completion)
        try:
            remove_writing(record, state)
            completion.pop('registryError', None)
        except (OSError, ValueError, KeyError) as error:
            completion['registryError'] = {'observedAt': now(), 'cause': str(error)}
        atomic(target, completion)
        if not completion.get('delivery'):
            try:
                # Always invoke the supported helper in configured Main, never in the worker checkout.
                helper = main / 'tools/goal/src/code-only-completion.ts'
                runtime = Path(bun).resolve() if bun else main / 'node_modules/.bin/bun'
                env = dict(os.environ, GOAL_MAIN_CHECKOUT=str(main), GOAL_STATE_DIRECTORY=str(state))
                call = subprocess.run([str(runtime), str(helper), str(target)], cwd=main, env=env,
                                      text=True, capture_output=True)
                if call.returncode:
                    raise RuntimeError(f'native helper exit {call.returncode}: {(call.stderr or call.stdout)[-4096:]}')
                delivery = json.loads(call.stdout)
                if not isinstance(delivery, dict) or not isinstance(delivery.get('id'), int) or delivery['id'] < 1:
                    raise ValueError('native helper returned no inbox row id')
                completion['delivery'] = {**delivery, 'deliveredAt': now()}
                completion.pop('deliveryError', None)
            except (OSError, ValueError, RuntimeError) as error:
                failure = {'observedAt': now(), 'cause': str(error)}
                completion['deliveryError'] = failure
                completion.setdefault('deliveryErrors', []).append(failure)
            atomic(target, completion)
        return {'id': record['id'], 'completionPath': str(target),
                'delivery': completion.get('delivery'), 'deliveryError': completion.get('deliveryError'),
                'sourceErrors': completion['source'].get('errors'), 'handoffError': completion.get('handoffError'),
                'registryError': completion.get('registryError')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', required=True)
    parser.add_argument('--main', default=os.environ.get('GOAL_MAIN_CHECKOUT'),
                        required=not os.environ.get('GOAL_MAIN_CHECKOUT'))
    parser.add_argument('--state', default=os.environ.get('GOAL_STATE_DIRECTORY'),
                        required=not os.environ.get('GOAL_STATE_DIRECTORY'))
    parser.add_argument('--bun', help='Absolute Bun executable; defaults to configured Main/node_modules/.bin/bun')
    parser.add_argument('--retry-source', action='store_true', help='Retry failed source/log evidence capture')
    args = parser.parse_args()
    result = finish(args.record, main=args.main, state=args.state, bun=args.bun, retry_source=args.retry_source)
    print(json.dumps(result))
    if any(result.get(key) for key in ('deliveryError', 'sourceErrors', 'handoffError', 'registryError')):
        raise SystemExit(1)
