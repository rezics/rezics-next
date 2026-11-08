/** Shared by existing slot admission and the owned run supervisor; no additional host process or watcher. */
export const checkHostPressureProgram = String.raw`
import fcntl, json, os, time
from pathlib import Path

def pressure_transition(previous, memory_full, io_full, now, boot, ordinary=False):
    state = dict(previous) if previous.get('boot') == boot else {'boot': boot, 'paused': False}
    if memory_full >= 1 or io_full >= 10:
        state.update(paused=True)
        state.pop('healthySince', None)
    elif state.get('paused'):
        if memory_full < 0.2 and io_full < 2:
            state.setdefault('healthySince', now)
            if now - state['healthySince'] >= 30:
                state.update(paused=False)
                state.pop('healthySince', None)
        else:
            state.pop('healthySince', None)
    severe = memory_full >= 5 or io_full >= 25
    if severe:
        state.setdefault('severeSince', now)
    else:
        state.pop('severeSince', None)
    shed = ordinary and severe and now - state['severeSince'] >= 15 and now - state.get('lastShed', -1e12) >= 30
    if shed:
        state['lastShed'] = now
    return state, shed

def update_host_pressure(directory, ordinary=False):
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    with open(root / '.host-pressure.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True, False, None
        def full(resource):
            for line in Path('/proc/pressure/' + resource).read_text().splitlines():
                if line.startswith('full '):
                    return float(dict(item.split('=') for item in line.split()[1:])['avg10'])
            return 0
        try:
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            memory_full, io_full = full('memory'), full('io')
        except (OSError, ValueError, KeyError):
            return False, False, None
        path = root / '.host-pressure.json'
        try:
            previous = json.loads(path.read_text())
            if not isinstance(previous, dict): previous = {}
        except (OSError, ValueError):
            previous = {}
        now = time.monotonic()
        state, shed = pressure_transition(previous, memory_full, io_full, now, boot, ordinary)
        if state != previous:
            pending = root / '.host-pressure.json.pending'
            pending.write_text(json.dumps(state, sort_keys=True))
            os.replace(pending, path)
        return state.get('paused', False), shed, {'memoryFull': memory_full, 'ioFull': io_full,
            'sustainedMs': max(0, round((now - state.get('severeSince', now)) * 1000))}
`;
