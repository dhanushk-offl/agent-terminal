"""Check packaged GUI startup under an isolated X11 or Wayland desktop."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def stop(process):
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def smoke(image, binary, backend):
    with tempfile.TemporaryDirectory(prefix="agent-image-smoke-") as temp:
        root = Path(temp)
        env = {"HOME": str(root), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": str(root / "runtime"), "LIBGL_ALWAYS_SOFTWARE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"}
        (root / "runtime").mkdir(mode=0o700)
        if image:
            subprocess.run([str(image), "--appimage-extract"], cwd=root, env=env, check=True, stdout=subprocess.DEVNULL)
            app = root / "squashfs-root/AppRun"
        else:
            app = binary
        command = ["dbus-run-session", "--", str(app)]
        compositor = process = None
        with (root / "startup.log").open("w+") as log:
            try:
                if backend == "wayland":
                    env.update({"WAYLAND_DISPLAY": "agent-terminal-test", "GDK_BACKEND": "wayland"})
                    compositor = subprocess.Popen(["weston", "--backend=headless-backend.so", "--socket=agent-terminal-test", "--idle-time=0"], env=env, stdout=log, stderr=log, start_new_session=True)
                    for _ in range(100):
                        if (root / "runtime/agent-terminal-test").exists():
                            break
                        if compositor.poll() is not None:
                            raise RuntimeError("Wayland compositor failed to start")
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("Wayland compositor startup timed out")
                else:
                    env["GDK_BACKEND"] = "x11"
                    command = ["xvfb-run", "-a", *command]
                process = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
                try:
                    code = process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    print(f"PASS {'AppImage' if image else 'native package'} remained running under {backend}")
                else:
                    raise RuntimeError(f"AppImage exited during startup: {code}")
            except Exception:
                log.flush()
                print((root / "startup.log").read_text(errors="replace"))
                raise
            finally:
                stop(process)
                stop(compositor)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--image", type=Path)
    target.add_argument("--binary", type=Path)
    parser.add_argument("--backend", choices=["x11", "wayland"], required=True)
    args = parser.parse_args()
    smoke(args.image.resolve() if args.image else None, args.binary, args.backend)
