"""Keep orphaned Auth UI descendants waitable until this page-app generation exits."""

import ctypes
import os
import signal
import sys


def main(command):
    # The outer check process can remain alive for another sign-in. Reap here
    # so process-group disappearance doesn't depend on that process exiting.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")

    stopping = False

    def on_term(signum, frame):
        nonlocal stopping
        stopping = True

    # The lifecycle sends TERM to the entire group. Its leader stays alive
    # to wait for the command and children adopted during that shutdown.
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    child = os.posix_spawnp(command[0], command, os.environ, setsigdef=(signal.SIGTERM,))
    if stopping:  # TERM may have arrived before the command joined the group.
        os.kill(child, signal.SIGTERM)

    exit_code = None
    while True:
        try:
            pid, status = os.wait()
        except ChildProcessError:
            if exit_code is None:
                raise RuntimeError("Lost Auth command exit status")
            return exit_code
        if pid == child:
            code = os.waitstatus_to_exitcode(status)
            exit_code = code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
