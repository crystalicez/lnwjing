import json
import os
from pathlib import Path
import select
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest
import wave


@unittest.skipUnless(os.environ.get("LNWJING_NATIVE_MEDIA_IPC_TEST") == "1", "Requires isolated PulseAudio, Xvfb, GStreamer and the compiled Linux native binary")
class NativeMediaIpcTests(unittest.TestCase):
    def test_actual_native_pulse_artifact_owner_isolation_and_cleanup(self):
        self.run_owned_media(False)

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_MEDIA_TEST_SCREEN") == "1", "Requires an isolated usable Xvfb socket directory")
    def test_actual_native_x11_screen_artifact_owner_isolation_and_cleanup(self):
        self.run_owned_media(True)

    def run_owned_media(self, include_screen):
        runtime = Path(os.environ["LNWJING_GSTREAMER_RUNTIME_ROOT"])
        binary = os.environ["LNWJING_NATIVE_TEST_BIN"]
        artifact_root = os.environ.get("LNWJING_GSTREAMER_ARTIFACT_DIR")
        children = []
        held_files = []
        with tempfile.TemporaryDirectory(prefix="lnwjing-native-media-") as temporary:
            root = Path(temporary)
            modules = next((runtime / "usr/lib").glob("pulse-*/modules"))
            libraries = str(runtime / "usr/lib/x86_64-linux-gnu") + ":" + str(runtime / "usr/lib/x86_64-linux-gnu/pulseaudio") + ":" + str(modules)
            environment = dict(os.environ, LD_LIBRARY_PATH=libraries, XDG_RUNTIME_DIR=temporary, HOME=temporary)
            log = open(root / "services.log", "wb")
            native_process = None
            try:
                display = None
                if include_screen:
                    read_fd, write_fd = os.pipe()
                    try:
                        xvfb = subprocess.Popen(["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "640x480x24", "-nolisten", "tcp", "-noreset", "-ac"], pass_fds=(write_fd,), stdout=log, stderr=log, env=environment)
                        children.append(xvfb)
                        os.close(write_fd)
                        write_fd = None
                        self.assertTrue(select.select([read_fd], [], [], 5)[0], "Isolated Xvfb did not select a display")
                        display = os.read(read_fd, 64).decode().strip()
                        self.assertTrue(display.isdecimal(), (root / "services.log").read_text(errors="replace"))
                    finally:
                        os.close(read_fd)
                        if write_fd is not None:
                            os.close(write_fd)
                socket = root / "pulse.sock"
                pulse = subprocess.Popen([str(runtime / "usr/bin/pulseaudio"), "--daemonize=no", "--use-pid-file=no", "--exit-idle-time=-1", "--disable-shm", "-n", "--dl-search-path=" + str(modules), "--load=module-null-sink sink_name=lnwjing_fixture rate=44100 channels=1", "--load=module-native-protocol-unix socket=" + str(socket) + " auth-anonymous=1"], stdout=log, stderr=log, env=environment)
                children.append(pulse)
                deadline = time.monotonic() + 5
                while not socket.exists() and pulse.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(socket.exists(), (root / "services.log").read_text(errors="replace"))
                wrapper_dir = root / "bin"
                wrapper_dir.mkdir()
                plugins = root / "plugins"
                plugins.mkdir()
                for name in ("coreelements", "audioconvert", "audioresample", "wavenc", "wavparse", "pulseaudio", "playback", "typefindfunctions", "videotestsrc", "videoconvertscale", "videorate", "ximagesrc", "openh264", "videoparsersbad", "isomp4", "videocrop"):
                    filename = "libgst" + name + ".so"
                    candidates = [runtime / "usr/lib/x86_64-linux-gnu/gstreamer-1.0" / filename, Path("/usr/lib/x86_64-linux-gnu/gstreamer-1.0") / filename]
                    source = next(path for path in candidates if path.is_file())
                    (plugins / filename).symlink_to(source)
                wrapper = wrapper_dir / "python3"
                wrapper.write_text("#!/bin/sh\n" + "\n".join("export " + name + "=" + shlex.quote(value) for name, value in {
                    "GI_TYPELIB_PATH": str(runtime / "usr/lib/x86_64-linux-gnu/girepository-1.0"),
                    "LD_LIBRARY_PATH": libraries,
                    "GST_PLUGIN_PATH": str(plugins),
                    "GST_PLUGIN_SYSTEM_PATH": "",
                    "GST_REGISTRY": str(root / "registry.bin"),
                }.items()) + '\nexec /usr/bin/python3 "$@"\n')
                wrapper.chmod(0o700)
                environment.update(PATH=str(wrapper_dir) + ":" + os.environ["PATH"], XDG_SESSION_TYPE="x11", PULSE_SERVER="unix:" + str(socket))
                if display is not None:
                    environment["DISPLAY"] = ":" + display
                else:
                    environment.pop("DISPLAY", None)
                native_process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, env=environment)
                request_id = 0
                def call(operation, action, parameters, client="client", session="session", workspace="workspace"):
                    nonlocal request_id
                    request_id += 1
                    owner = {"clientId": client, "sessionId": session}
                    if workspace is not None:
                        owner["workspaceId"] = workspace
                    native_process.stdin.write(json.dumps({"id": str(request_id), "operation": operation, "input": {"action": action, "parameters": parameters, "metadata": {"lnwjing.taskOwner.v1": owner}}}) + "\n")
                    native_process.stdin.flush()
                    self.assertTrue(select.select([native_process.stdout], [], [], 10)[0], "Native media did not answer")
                    return json.loads(native_process.stdout.readline())
                operations = [("audio", "record", "wav")]
                if include_screen:
                    operations.append(("screen_record", "start", "mp4"))
                for operation, action, extension in operations:
                    target = root / ("ไทย😀." + extension)
                    started_at = time.monotonic()
                    started = call(operation, action, {"output_path": str(target), "duration_seconds": 2, "max_bytes": 1048576, **({"width": 320, "height": 240, "fps": 15} if operation == "screen_record" else {})})
                    self.assertTrue(started["ok"], started)
                    self.assertEqual(started["value"]["state"], "running")
                    handle = started["value"]["handle"]
                    observations = [("started", time.monotonic() - started_at, [(path.name, path.stat().st_size) for path in root.glob(".lnwjing-*")])]
                    held_file = next(root.glob(".lnwjing-*")).open("rb")
                    held_files.append(held_file)
                    for client, session, workspace in (("foreign", "session", "workspace"), ("client", "foreign", "workspace"), ("client", "session", "foreign")):
                        for forbidden_action in ("status", "stop"):
                            denied = call(operation, forbidden_action, {"handle": handle}, client, session, workspace)
                            self.assertFalse(denied["ok"], denied)
                            self.assertEqual(denied["error"]["code"], "FILE_NOT_FOUND")
                    deadline = time.monotonic() + 6
                    status = call(operation, "status", {"handle": handle}, workspace=None)
                    observations.append(("first_status", time.monotonic() - started_at, [(path.name, path.stat().st_size) for path in root.glob(".lnwjing-*")]))
                    while status["value"]["state"] == "running" and time.monotonic() < deadline:
                        time.sleep(0.03)
                        observations.append(("poll", time.monotonic() - started_at, [(path.name, path.stat().st_size) for path in root.glob(".lnwjing-*")]))
                        status = call(operation, "status", {"handle": handle}, workspace=None)
                    metadata = {"actual_bytes": os.fstat(held_file.fileno()).st_size}
                    if extension == "wav":
                        with wave.open(held_file, "rb") as recorded:
                            metadata.update(frames=recorded.getnframes(), sample_rate=recorded.getframerate())
                    self.assertEqual(status["value"]["state"], "completed", (status, observations, metadata))
                    artifact = status["value"]["artifact"]
                    self.assertTrue(artifact["verified"])
                    self.assertEqual(artifact["byte_length"], target.stat().st_size)
                    if extension == "wav":
                        with wave.open(str(target), "rb") as audio:
                            self.assertEqual(len(audio.readframes(audio.getnframes())), audio.getnframes() * audio.getnchannels() * audio.getsampwidth())
                    if artifact_root:
                        shutil.copyfile(target, str(Path(artifact_root) / ("native-verified." + extension)))
                for number in range(20):
                    target = root / ("cycle-%d.wav" % number)
                    start = call("audio", "record", {"output_path": str(target), "duration_seconds": 0.1})
                    self.assertTrue(start["ok"], start)
                    stopped = call("audio", "stop", {"handle": start["value"]["handle"], "cancel": True})
                    self.assertEqual(stopped["value"]["state"], "cancelled")
                    self.assertFalse(target.exists())
                helpers = Path("/proc/%d/task/%d/children" % (native_process.pid, native_process.pid)).read_text().split()
                self.assertEqual(len(helpers), 1)
                native_process.stdin.close()
                native_process.wait(timeout=5)
                self.assertTrue(all(not Path("/proc/" + pid).exists() for pid in helpers))
            finally:
                if native_process is not None:
                    if native_process.poll() is None:
                        native_process.kill()
                        native_process.wait(timeout=5)
                    if not native_process.stdin.closed:
                        native_process.stdin.close()
                    native_process.stdout.close()
                for process in reversed(children):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                log.close()
                for held_file in held_files:
                    held_file.close()


if __name__ == "__main__":
    unittest.main()
