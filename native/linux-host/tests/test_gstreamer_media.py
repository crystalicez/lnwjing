import gc
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import wave
import weakref
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("desktop_session", Path(__file__).parents[1] / "src" / "desktop_session.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


@unittest.skipUnless(os.environ.get("LNWJING_GSTREAMER_TEST") == "1", "Requires an isolated or configured GStreamer runtime")
class GStreamerMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        native.load_dependencies()
        for name in ("audiotestsrc", "videotestsrc", "wavenc", "playbin", "fakesink", "openh264enc", "h264parse", "mp4mux"):
            if not native.Gst.ElementFactory.find(name):
                raise RuntimeError("Required real GStreamer plugin is unavailable: " + name)

    def drive_terminal(self, resource):
        context = native.GLib.MainContext.default()
        deadline = time.monotonic() + 6
        while resource.state == "running" and time.monotonic() < deadline:
            while context.pending():
                context.iteration(False)
            time.sleep(0.005)
        self.assertNotEqual(resource.state, "running", "Actual GStreamer operation did not finish")

    def source_element(self, name, properties=None):
        if name in ("pulsesrc", "ximagesrc"):
            return self.original_element("audiotestsrc" if name == "pulsesrc" else "videotestsrc", {"is-live": True})
        result = self.original_element(name, properties)
        if name == "playbin":
            result.set_property("audio-sink", self.original_element("fakesink", {"sync": False}))
        return result

    def refusing_pipeline(self):
        class RefusingElement(native.Gst.Element):
            refuse = True

            def do_change_state(self, transition):
                if self.refuse and transition in (native.Gst.StateChange.PLAYING_TO_PAUSED, native.Gst.StateChange.PAUSED_TO_READY, native.Gst.StateChange.READY_TO_NULL):
                    return native.Gst.StateChangeReturn.FAILURE
                return native.Gst.Element.do_change_state(self, transition)
        element = RefusingElement()
        pipeline = native.Gst.Pipeline.new(None)
        pipeline.add(element)
        self.assertNotEqual(pipeline.set_state(native.Gst.State.PLAYING), native.Gst.StateChangeReturn.FAILURE)
        self.addCleanup(lambda: (setattr(element, "refuse", False), pipeline.set_state(native.Gst.State.NULL)))
        return pipeline, element

    def assert_quarantined(self, resource, element):
        receipt = resource.receipt("owned")
        self.assertEqual(receipt["state"], "termination_unverified", receipt)
        self.assertEqual(receipt["deliveryState"], "termination_unverified")
        self.assertTrue(receipt["running"])
        self.assertFalse(receipt["termination_verified"])
        self.assertIsNone(resource.finished_at)
        self.assertNotEqual(element.get_state(0)[1], native.Gst.State.NULL)
        self.assertFalse(resource.resources.closed)
        self.assertTrue(resource.resources.watching)
        self.assertTrue(resource.resources.bus.handler_is_connected(resource.resources.handler))
        self.assertNotIn("artifact", receipt)

    def test_failed_null_transition_retains_playback_until_verified_retry(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "input.wav"
            path.write_bytes(b"owned fixture")
            pipeline, element = self.refusing_pipeline()
            with patch.object(native, "element", return_value=pipeline):
                player = native.Playback({"file_path": str(path)})
            timer = player.resources.timer
            self.assertFalse(player.stop("cancelled"))
            self.assert_quarantined(player, element)
            self.assertEqual(player.resources.timer, timer)
            self.assertFalse(player.stop())
            self.assert_quarantined(player, element)
            element.refuse = False
            self.assertTrue(player.stop())
            self.assertEqual(player.receipt("owned")["state"], "cancelled")
            self.assertFalse(player.receipt("owned")["running"])
            self.assertTrue(player.resources.closed)
            self.assertIsNone(player.resources.timer)

    def test_failed_recording_eos_does_not_publish_and_cancel_can_retry(self):
        with tempfile.TemporaryDirectory() as root:
            pipeline, element = self.refusing_pipeline()
            with patch.object(native, "pipeline_for", return_value=pipeline), patch.object(native, "element", return_value=object()):
                recording = native.Recording("audio", {"output_path": str(Path(root) / "never.wav")})
            with patch.object(native, "publish_artifact") as publish:
                recording.message(recording.resources.bus, SimpleNamespace(type=native.Gst.MessageType.EOS))
                publish.assert_not_called()
            self.assert_quarantined(recording, element)
            self.assertTrue(Path(recording.temporary).exists())
            self.assertFalse(Path(recording.target).exists())
            recording.stop(cancel=True)
            self.assert_quarantined(recording, element)
            element.refuse = False
            recording.stop(cancel=True)
            self.assertFalse(recording.receipt("owned")["running"])
            self.assertEqual(recording.state, "failed")
            self.assertFalse(Path(recording.temporary).exists())
            self.assertFalse(Path(recording.target).exists())

    def test_failed_startup_retains_its_real_pipeline_and_retry_handle(self):
        original_observe = native.GstResources.observe
        def fail_observe(resources, callback):
            original_observe(resources, callback)
            raise native.Failure("INTERNAL_ERROR")
        with tempfile.TemporaryDirectory() as root, patch.object(native.GstResources, "observe", fail_observe):
            path = Path(root) / "input.wav"
            path.write_bytes(b"owned fixture")
            for recording in (False, True):
                pipeline, element = self.refusing_pipeline()
                with patch.object(native, "element", return_value=pipeline if not recording else object()), patch.object(native, "pipeline_for", return_value=pipeline):
                    resource = native.Recording("audio", {"output_path": str(Path(root) / "start.wav")}) if recording else native.Playback({"file_path": str(path)})
                self.assert_quarantined(resource, element)
                element.refuse = False
                resource.stop(cancel=True) if recording else resource.stop("cancelled")
                self.assertFalse(resource.receipt("owned")["running"])
                self.assertTrue(resource.resources.closed)

    def test_one_shot_capture_retains_unverified_cleanup_for_helper_escalation(self):
        pipeline, element = self.refusing_pipeline()
        sessions = native.DesktopSessions()
        portal = SimpleNamespace(remote=False, source_type=1, closed=False, source=lambda: object(), close=lambda: None)
        sessions.portals["capture"] = portal
        sink = SimpleNamespace(emit=lambda *args: None)
        with patch.object(native, "pipeline_for", return_value=pipeline), patch.object(native, "element", return_value=sink):
            with self.assertRaises(native.Failure) as failed:
                sessions.capture("capture_display", {"session_id": "capture"})
        self.assertEqual(failed.exception.code, "PROCESS_TIMEOUT")
        self.assertEqual(len(sessions.capture_resources), 1)
        self.assertFalse(sessions.close())
        self.assertEqual(len(sessions.capture_resources), 1)
        self.assertNotEqual(element.get_state(0)[1], native.Gst.State.NULL)
        element.refuse = False
        self.assertTrue(sessions.close())
        self.assertEqual(sessions.capture_resources, [])

    def test_actual_wav_mp4_and_playback_use_verified_artifacts_and_release_callbacks(self):
        self.original_element = native.element
        artifact_root = os.environ.get("LNWJING_GSTREAMER_ARTIFACT_DIR")
        if artifact_root:
            Path(artifact_root).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=artifact_root, prefix="gst-") as root, patch.object(native, "element", self.source_element):
            for kind in ("audio", "screen"):
                path = os.path.join(root, "ไทย-😀." + ("wav" if kind == "audio" else "mp4"))
                recording = native.Recording(kind, {"output_path": path, "duration_seconds": "0.4", "width": "320", "height": "240", "fps": "15", "max_bytes": "1048576"})
                bus, handler = recording.resources.bus, recording.resources.handler
                self.drive_terminal(recording)
                receipt = recording.receipt("fixture")
                self.assertEqual(receipt["state"], "completed", receipt)
                self.assertTrue(receipt["artifact"]["verified"])
                self.assertGreater(receipt["artifact"]["duration_seconds"], 0)
                self.assertEqual(receipt["artifact"]["byte_length"], Path(path).stat().st_size)
                self.assertFalse(bus.handler_is_connected(handler))
                self.assertIsNone(recording.resources.timer)
                if kind == "audio":
                    with wave.open(path, "rb") as audio:
                        pcm = audio.readframes(audio.getnframes())
                        self.assertEqual(len(pcm), audio.getnframes() * audio.getnchannels() * audio.getsampwidth())
                    player = native.Playback({"file_path": path, "duration_seconds": "1", "max_bytes": "1048576"})
                    play_bus, play_handler = player.resources.bus, player.resources.handler
                    self.drive_terminal(player)
                    self.assertEqual(player.receipt("player")["state"], "completed")
                    self.assertEqual(player.receipt("player")["byte_limit"], 1048576)
                    self.assertFalse(play_bus.handler_is_connected(play_handler))
                    player_ref = weakref.ref(player)
                    del player
                    gc.collect()
                    self.assertIsNone(player_ref())
                if artifact_root:
                    import shutil
                    shutil.copyfile(path, os.path.join(artifact_root, "verified." + receipt["artifact"]["format"]))
                recording_ref = weakref.ref(recording)
                del recording
                gc.collect()
                self.assertIsNone(recording_ref())

    def test_actual_repeated_cancel_and_eos_leave_no_connected_bus_callbacks(self):
        self.original_element = native.element
        with tempfile.TemporaryDirectory() as root, patch.object(native, "element", self.source_element):
            for number in range(20):
                recording = native.Recording("audio", {"output_path": os.path.join(root, str(number) + ".wav"), "duration_seconds": "0.1"})
                bus, handler = recording.resources.bus, recording.resources.handler
                if number % 2:
                    recording.stop(cancel=True)
                else:
                    self.drive_terminal(recording)
                    self.assertEqual(recording.state, "completed", recording.receipt("fixture"))
                self.assertFalse(bus.handler_is_connected(handler))
                self.assertIsNone(recording.resources.timer)
                recording_ref = weakref.ref(recording)
                del recording
                gc.collect()
                self.assertIsNone(recording_ref())


if __name__ == "__main__":
    unittest.main()
