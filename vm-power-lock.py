"""Hold one kernel file lock for the lifetime of a parent-owned stdin pipe."""
import errno
import os
import sys
import time

if os.name == "nt":
    import msvcrt

    def try_lock(stream):
        stream.seek(65536)  # Leave the legacy JSON header readable while locked.
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
else:
    import fcntl

    def try_lock(stream):
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)


def main(filename, timeout):
    deadline = time.monotonic() + timeout
    # Keep the inode. Removing it would allow a second lock on a different file.
    with open(filename, "a+b") as stream:
        while True:
            try:
                try_lock(stream)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if time.monotonic() >= deadline:
                    return 2
                time.sleep(0.1)
        print("locked", flush=True)
        sys.stdin.buffer.read(1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], int(sys.argv[2]) / 1000))
