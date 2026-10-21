import base64
import json
import math
import os
import signal
import stat
import sys
import time
import uuid
import wave

MAX_MEDIA_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_DURATION = 600
MAX_HANDLES = 16
Gio = GLib = Gst = GstVideo = GstPbutils = GdkPixbuf = None
ACTIONS = {
    "audio": ["status", "record", "play", "stop"],
    "screen_record": ["status", "start", "stop"],
    "vision": ["status", "capture_display", "capture_region", "capture_window"],
    "input_event": ["status", "type_text", "press_key", "hotkey", "mouse_move", "click", "double_click", "right_click", "scroll", "drag", "key_down", "key_up", "button_down", "button_up", "release_all"],
}


def unavailable_status(operation):
    return {"available": False, "ready": False, "reason": "dependency_missing", "readinessReason": "dependency_missing", "backend": "gio-gstreamer", "supportedActions": ACTIONS.get(operation, ["status"])}


class Failure(Exception):
    def __init__(self, code):
        self.code = code


def bounds(value, default, minimum, maximum):
    if value is None:
        return default
    if isinstance(value, bool):
        raise Failure("INVALID_INPUT")
    try:
        number = float(value)
    except (ValueError, TypeError):
        raise Failure("INVALID_INPUT")
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise Failure("INVALID_INPUT")
    return number


def integer(value, default, minimum, maximum):
    number = bounds(value, default, minimum, maximum)
    if number != int(number):
        raise Failure("INVALID_INPUT")
    return int(number)


def load_gio():
    global Gio, GLib
    if Gio is not None:
        return
    try:
        import gi
        from gi.repository import Gio as gio, GLib as glib
        Gio, GLib = gio, glib
    except (ImportError, ValueError):
        raise Failure("EXECUTABLE_NOT_FOUND")


def load_dependencies():
    global Gst, GstVideo, GstPbutils, GdkPixbuf
    load_gio()
    if Gst is not None:
        return
    try:
        import gi
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        gi.require_version("GstPbutils", "1.0")
        gi.require_version("GdkPixbuf", "2.0")
        from gi.repository import Gst as gst, GstVideo as video, GstPbutils as pbutils, GdkPixbuf as pixbuf
        Gst, GstVideo, GstPbutils, GdkPixbuf = gst, video, pbutils, pixbuf
        Gst.init(None)
    except (ImportError, ValueError):
        raise Failure("EXECUTABLE_NOT_FOUND")


def element(name, properties=None):
    result = Gst.ElementFactory.make(name)
    if result is None:
        raise Failure("EXECUTABLE_NOT_FOUND")
    for key, value in (properties or {}).items():
        result.set_property(key, value)
    return result


def pipeline_for(elements):
    pipeline = Gst.Pipeline.new(None)
    for item in elements:
        pipeline.add(item)
    for before, after in zip(elements, elements[1:]):
        if not before.link(after):
            raise Failure("INTERNAL_ERROR")
    return pipeline


def private_output(input, extension):
    target = input.get("output_path")
    if not isinstance(target, str) or not os.path.isabs(target) or "\0" in target or len(target) > 4096:
        raise Failure("INVALID_INPUT")
    if os.path.lexists(target):
        raise Failure("CONFLICT")
    parent = os.path.dirname(target)
    if not os.path.isdir(parent):
        raise Failure("FILE_NOT_FOUND")
    temporary = os.path.join(parent, ".lnwjing-" + uuid.uuid4().hex + "." + extension)
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.close(fd)
    return target, temporary


def video_settings(input, portal=None):
    fps = integer(input.get("fps"), 15, 1, 60)
    region_requested = any(name in input for name in ("offset_x", "offset_y", "width", "height"))
    result = {"fps": fps, "width": 1280, "height": 720, "crop": None, "source": {}}
    if not region_requested:
        return result
    if "width" not in input or "height" not in input:
        raise Failure("INVALID_INPUT")
    x = integer(input.get("offset_x"), 0, -16384, 16384)
    y = integer(input.get("offset_y"), 0, -16384, 16384)
    width = integer(input["width"], 1280, 2, 7680)
    height = integer(input["height"], 720, 2, 4320)
    if width % 2 or height % 2:
        raise Failure("INVALID_INPUT")
    if portal:
        size = portal.properties.get("size")
        origin = portal.properties.get("position")
        if not size or not origin:
            raise Failure("INVALID_INPUT")
        left, top = x - origin[0], y - origin[1]
        if left < 0 or top < 0 or left + width > size[0] or top + height > size[1]:
            raise Failure("INVALID_INPUT")
        result["crop"] = (left / size[0], top / size[1], (size[0] - left - width) / size[0], (size[1] - top - height) / size[1])
    else:
        if x < 0 or y < 0:
            raise Failure("INVALID_INPUT")
        result["source"] = {"startx": x, "starty": y, "endx": x + width - 1, "endy": y + height - 1}
    result.update({"width": width, "height": height})
    return result


def publish_artifact(target, temporary, kind, byte_limit, duration_limit=MAX_DURATION):
    info = os.lstat(temporary)
    if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
        raise Failure("INTERNAL_ERROR")
    if info.st_size > byte_limit:
        raise Failure("FILE_TOO_LARGE")
    if kind == "audio":
        with wave.open(temporary, "rb") as audio:
            if audio.getnframes() < 1 or audio.getnchannels() not in (1, 2) or audio.getsampwidth() != 2:
                raise Failure("INTERNAL_ERROR")
            expected = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            if expected > info.st_size:
                raise Failure("INTERNAL_ERROR")
            actual = 0
            while actual < expected:
                chunk = audio.readframes(min(16384, audio.getnframes()))
                if not chunk:
                    break
                actual += len(chunk)
            if actual != expected:
                raise Failure("INTERNAL_ERROR")
            duration = audio.getnframes() / audio.getframerate()
            details = {"sample_rate": audio.getframerate(), "channels": audio.getnchannels()}
    else:
        discoverer = GstPbutils.Discoverer.new(3 * Gst.SECOND)
        discovery = discoverer.discover_uri(GLib.filename_to_uri(temporary, None))
        if discovery.get_result() != GstPbutils.DiscovererResult.OK or not discovery.get_video_streams():
            raise Failure("INTERNAL_ERROR")
        duration = discovery.get_duration() / Gst.SECOND
        video = discovery.get_video_streams()[0]
        details = {"width": video.get_width(), "height": video.get_height()}
    if not math.isfinite(duration) or duration <= 0 or duration > duration_limit + 0.2:
        raise Failure("INTERNAL_ERROR")
    try:
        os.link(temporary, target, follow_symlinks=False)
    except FileExistsError:
        raise Failure("CONFLICT")
    try:
        os.unlink(temporary)
    except OSError:
        pass
    return {"file_path": target, "output_path": target, "byte_length": info.st_size, "duration_seconds": duration, "format": "wav" if kind == "audio" else "mp4", "mime_type": "audio/wav" if kind == "audio" else "video/mp4", "verified": True, **details}


class PortalSession:
    destination = "org.freedesktop.portal.Desktop"
    path = "/org/freedesktop/portal/desktop"

    def __init__(self, remote, source_type=1):
        self.remote = remote
        self.source_type = source_type
        self.connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.session = None
        self.closed = False
        self.closing = False
        self.keys = set()
        self.buttons = set()
        self.fd = None
        self.stream = None
        self.properties = {}
        self.deadline = time.monotonic() + 60
        self.interface = "org.freedesktop.portal.RemoteDesktop" if remote else "org.freedesktop.portal.ScreenCast"
        try:
            result = self.request(self.interface, "CreateSession", "(a{sv})", [{"session_handle_token": GLib.Variant("s", "s" + uuid.uuid4().hex)}])
            self.session = result["session_handle"]
            self.subscription = self.connection.signal_subscribe(self.destination, "org.freedesktop.portal.Session", "Closed", self.session, None, Gio.DBusSignalFlags.NONE, self.on_closed)
            if remote:
                self.request(self.interface, "SelectDevices", "(oa{sv})", [self.session, {"types": GLib.Variant("u", 3)}])
            self.request("org.freedesktop.portal.ScreenCast", "SelectSources", "(oa{sv})", [self.session, {"types": GLib.Variant("u", source_type), "multiple": GLib.Variant("b", False)}])
            result = self.request(self.interface, "Start", "(osa{sv})", [self.session, "", {}])
            streams = result.get("streams", [])
            if len(streams) != 1:
                raise Failure("PERMISSION_REQUIRED")
            self.stream, self.properties = streams[0]
            if remote and result.get("devices", 0) & 3 != 3:
                raise Failure("PERMISSION_REQUIRED")
            reply, descriptors = self.connection.call_with_unix_fd_list_sync(self.destination, self.path, "org.freedesktop.portal.ScreenCast", "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE, 3000, None, None)
            self.fd = descriptors.get(reply.unpack()[0])
        except Exception:
            self.close()
            raise

    def on_closed(self, *args):
        self.closed = True
        self.close()

    def request(self, interface, method, signature, arguments):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Failure("PROCESS_TIMEOUT")
        token = "r" + uuid.uuid4().hex
        arguments[-1]["handle_token"] = GLib.Variant("s", token)
        sender = self.connection.get_unique_name().lstrip(":").replace(".", "_")
        expected = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token
        responses = []
        loop = GLib.MainLoop.new(None, False)

        def received(connection, sender_name, object_path, interface_name, signal_name, parameters):
            responses.append(parameters.unpack())
            loop.quit()

        subscription = self.connection.signal_subscribe(self.destination, "org.freedesktop.portal.Request", "Response", expected, None, Gio.DBusSignalFlags.NONE, received)
        timed_out = []
        def expired():
            timed_out.append(True)
            loop.quit()
            return False
        timeout = GLib.timeout_add(max(1, int(remaining * 1000)), expired)
        returned = None
        try:
            returned = self.connection.call_sync(self.destination, self.path, interface, method, GLib.Variant(signature, tuple(arguments)), GLib.VariantType.new("(o)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
            if returned != expected:
                self.connection.signal_unsubscribe(subscription)
                subscription = self.connection.signal_subscribe(self.destination, "org.freedesktop.portal.Request", "Response", returned, None, Gio.DBusSignalFlags.NONE, received)
            if not responses:
                loop.run()
            if not responses:
                raise Failure("PROCESS_TIMEOUT")
            code, values = responses[0]
            if code != 0:
                raise Failure("PERMISSION_REQUIRED")
            return values
        finally:
            self.connection.signal_unsubscribe(subscription)
            if not timed_out:
                GLib.source_remove(timeout)
            if returned and not responses:
                try:
                    self.connection.call_sync(self.destination, returned, "org.freedesktop.portal.Request", "Close", None, None, Gio.DBusCallFlags.NONE, 1000, None)
                except Exception:
                    pass

    def notify(self, method, signature, values):
        if self.closed:
            raise Failure("PERMISSION_REQUIRED")
        try:
            self.connection.call_sync(self.destination, self.path, "org.freedesktop.portal.RemoteDesktop", method, GLib.Variant(signature, (self.session, {}, *values)), None, Gio.DBusCallFlags.NONE, 1500, None)
        except Exception:
            if not self.closing:
                self.close()
            raise Failure("PERMISSION_REQUIRED")

    def key(self, key, pressed):
        self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", (key, 1 if pressed else 0))
        (self.keys.add if pressed else self.keys.discard)(key)

    def button(self, button, pressed):
        self.notify("NotifyPointerButton", "(oa{sv}iu)", (button, 1 if pressed else 0))
        (self.buttons.add if pressed else self.buttons.discard)(button)

    def release(self):
        for key in list(self.keys):
            self.key(key, False)
        for button in list(self.buttons):
            self.button(button, False)

    def source(self):
        if self.closed or self.fd is None:
            raise Failure("PERMISSION_REQUIRED")
        properties = {"fd": self.fd, "path": str(self.stream), "do-timestamp": True}
        serial = self.properties.get("pipewire-serial")
        source = element("pipewiresrc")
        if serial is not None and not source.find_property("target-object"):
            raise Failure("EXECUTABLE_NOT_FOUND")
        if serial is not None:
            properties["target-object"] = str(serial)
            properties.pop("path")
        for key, value in properties.items():
            source.set_property(key, value)
        return source

    def close(self):
        if getattr(self, "closing", False):
            return
        self.closing = True
        verified = self.closed or not self.session
        if not self.closed and self.session:
            if self.remote:
                for key in list(self.keys):
                    try:
                        self.key(key, False)
                    except Exception:
                        pass
                for button in list(self.buttons):
                    try:
                        self.button(button, False)
                    except Exception:
                        pass
            try:
                self.connection.call_sync(self.destination, self.session, "org.freedesktop.portal.Session", "Close", None, None, Gio.DBusCallFlags.NONE, 1000, None)
                verified = True
            except Exception:
                pass
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        self.closing = False
        if not verified:
            raise Failure("PROCESS_TIMEOUT")
        self.closed = True
        self.keys.clear()
        self.buttons.clear()
        if getattr(self, "subscription", None):
            self.connection.signal_unsubscribe(self.subscription)
            self.subscription = None


KEYS = {"enter": 0xff0d, "return": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b, "space": 0x20, "backspace": 0xff08, "left": 0xff51, "up": 0xff52, "right": 0xff53, "down": 0xff54, "ctrl": 0xffe3, "control": 0xffe3, "shift": 0xffe1, "alt": 0xffe9, "super": 0xffeb, "meta": 0xffeb, "delete": 0xffff, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56}


def keysym(value):
    if not isinstance(value, str) or not value:
        raise Failure("INVALID_INPUT")
    if len(value) == 1:
        code = ord(value)
        return code if code < 256 else 0x01000000 + code
    if value.lower() in KEYS:
        return KEYS[value.lower()]
    raise Failure("INVALID_INPUT")


class GstResources:
    def __init__(self, pipeline):
        self.pipeline = pipeline
        self.bus = pipeline.get_bus()
        self.handler = None
        self.watching = False
        self.timer = None
        self.closed = False

    def observe(self, callback):
        self.bus.add_signal_watch()
        self.watching = True
        self.handler = self.bus.connect("message", callback)

    def close(self):
        if self.closed:
            return True
        try:
            requested = self.pipeline.set_state(Gst.State.NULL)
            if requested == Gst.StateChangeReturn.FAILURE:
                return False
            result, current, _ = self.pipeline.get_state(2 * Gst.SECOND)
            if result != Gst.StateChangeReturn.SUCCESS or current != Gst.State.NULL:
                return False
            if self.timer is not None:
                GLib.source_remove(self.timer)
                self.timer = None
            if self.handler is not None:
                self.bus.disconnect(self.handler)
                self.handler = None
            if self.watching:
                self.bus.remove_signal_watch()
                self.watching = False
        except Exception:
            return False
        self.closed = True
        return True


class Playback:
    def __init__(self, input):
        self.limit = integer(input.get("max_bytes"), MAX_MEDIA_BYTES, 1024, MAX_MEDIA_BYTES)
        path = input.get("file_path")
        if not path or not os.path.isabs(path) or not os.path.isfile(path):
            raise Failure("INVALID_INPUT")
        if os.path.getsize(path) > self.limit:
            raise Failure("FILE_TOO_LARGE")
        self.duration = bounds(input.get("duration_seconds"), 60, 0.1, MAX_DURATION)
        self.state = "running"
        self.finished_at = None
        self.pending_state = None
        self.resources = None
        self.pipeline = element("playbin", {"uri": GLib.filename_to_uri(path, None)})
        try:
            self.resources = GstResources(self.pipeline)
            self.resources.observe(self.message)
            self.resources.timer = GLib.timeout_add(max(1, int(self.duration * 1000)), self.finish)
            if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise Failure("INTERNAL_ERROR")
        except Exception:
            if not self.stop("failed"):
                return
            raise

    def message(self, bus, message):
        if message.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
            self.stop("failed" if message.type == Gst.MessageType.ERROR else "completed")

    def finish(self):
        self.stop()
        return self.state == "termination_unverified"

    def stop(self, state="completed"):
        if self.state not in ("running", "termination_unverified"):
            return True
        if self.state == "running":
            self.pending_state = state
        if self.resources is None:
            self.resources = GstResources(self.pipeline)
        if not self.resources.close():
            self.state = "termination_unverified"
            return False
        self.state = self.pending_state or state
        self.finished_at = time.monotonic()
        return True

    def receipt(self, handle):
        live = self.state in ("running", "termination_unverified")
        receipt = {"handle": handle, "state": self.state, "running": live, "deliveryState": self.state if live else "failed" if self.state in ("failed", "cancelled") else "completed", "duration_limit_seconds": self.duration, "byte_limit": self.limit}
        if self.state == "termination_unverified":
            receipt.update({"termination_verified": False, "error": {"code": "PROCESS_TIMEOUT", "recoverable": True}})
        return receipt


class Recording:
    def __init__(self, kind, input, portal=None):
        self.kind = kind
        self.duration = bounds(input.get("duration_seconds"), 60, 0.1, MAX_DURATION)
        self.limit = integer(input.get("max_bytes"), MAX_MEDIA_BYTES, 1024, MAX_MEDIA_BYTES)
        self.target, self.temporary = private_output(input, "wav" if kind == "audio" else "mp4")
        self.portal = portal
        self.state = "running"
        self.error = None
        self.artifact = None
        self.started = time.monotonic()
        self.finishing = False
        self.finished_at = None
        self.resources = None
        self.pending_failure = None
        self.pending_state = "failed"
        try:
            if kind == "audio":
                elements = [element("pulsesrc"), element("audioconvert"), element("audioresample"), element("capsfilter", {"caps": Gst.Caps.from_string("audio/x-raw,format=S16LE,rate=44100,channels=1")}), element("wavenc"), element("filesink", {"location": self.temporary})]
            else:
                settings = video_settings(input, portal)
                source = portal.source() if portal else element("ximagesrc", {"use-damage": False, "show-pointer": True, **settings["source"]})
                crop = element("videocrop") if settings["crop"] else None
                if crop:
                    fractions = settings["crop"]
                    def negotiated(pad, info):
                        if info.type & Gst.PadProbeType.EVENT_DOWNSTREAM:
                            event = info.get_event()
                            if event.type == Gst.EventType.CAPS:
                                video_info = GstVideo.VideoInfo.new_from_caps(event.parse_caps())
                                if video_info:
                                    for key, fraction, extent in zip(("left", "top", "right", "bottom"), fractions, (video_info.width, video_info.height, video_info.width, video_info.height)):
                                        crop.set_property(key, int(fraction * extent))
                        return Gst.PadProbeReturn.OK
                    source.get_static_pad("src").add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, negotiated)
                caps = "video/x-raw,width=%d,height=%d,framerate=%d/1" % (settings["width"], settings["height"], settings["fps"])
                elements = [source] + ([crop] if crop else []) + [element("videoconvert"), element("videoscale"), element("videorate"), element("capsfilter", {"caps": Gst.Caps.from_string(caps)}), element("openh264enc", {"bitrate": 2_000_000}), element("h264parse"), element("mp4mux"), element("filesink", {"location": self.temporary})]
            self.pipeline = pipeline_for(elements)
            self.resources = GstResources(self.pipeline)
            self.resources.observe(self.message)
            if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise Failure("INTERNAL_ERROR")
            self.resources.timer = GLib.timeout_add(100, self.check_limit)
        except Exception as error:
            if hasattr(self, "pipeline"):
                if self.resources is None:
                    self.resources = GstResources(self.pipeline)
                if not self.resources.close():
                    self.quarantine(error.code if isinstance(error, Failure) else "INTERNAL_ERROR")
                    return
            if os.path.exists(self.temporary):
                os.unlink(self.temporary)
            raise

    def check_limit(self):
        if self.state == "termination_unverified":
            self.fail(self.pending_failure or "PROCESS_TIMEOUT", self.pending_state)
            return self.state == "termination_unverified"
        if self.state != "running":
            return self.state == "termination_unverified"
        if self.portal and self.portal.closed:
            self.fail("PERMISSION_REQUIRED")
            return self.state == "termination_unverified"
        size = os.path.getsize(self.temporary) if os.path.exists(self.temporary) else 0
        if size >= self.limit:
            self.fail("FILE_TOO_LARGE")
            return self.state == "termination_unverified"
        if time.monotonic() - self.started >= self.duration:
            self.stop()
        return self.state in ("running", "termination_unverified")

    def message(self, bus, message):
        if self.state != "running":
            return
        if message.type == Gst.MessageType.ERROR:
            self.fail("INTERNAL_ERROR")
        elif message.type == Gst.MessageType.EOS:
            if not self.resources.close():
                self.quarantine("PROCESS_TIMEOUT")
                return
            try:
                self.artifact = publish_artifact(self.target, self.temporary, self.kind, self.limit, self.duration)
                self.state = "completed"
                self.finished_at = time.monotonic()
            except Exception as error:
                self.fail(error.code if isinstance(error, Failure) else "INTERNAL_ERROR")

    def quarantine(self, code, state="failed"):
        self.pending_failure = code
        self.pending_state = state
        self.state = "termination_unverified"
        self.error = "PROCESS_TIMEOUT"

    def fail(self, code, state="failed"):
        if not self.resources.close():
            self.quarantine(code, state)
            return False
        self.state = state
        self.error = code
        self.finished_at = time.monotonic()
        if os.path.exists(self.temporary):
            os.unlink(self.temporary)
        return True

    def stop(self, cancel=False):
        if self.state == "termination_unverified":
            self.fail(self.pending_failure or "PROCESS_TIMEOUT", self.pending_state)
            return
        if self.state != "running":
            return
        if cancel:
            self.fail("PROCESS_TIMEOUT", "cancelled")
            return
        if not self.finishing:
            self.finishing = True
            if not self.pipeline.send_event(Gst.Event.new_eos()):
                self.fail("INTERNAL_ERROR")
                return
        deadline = time.monotonic() + 4
        context = GLib.MainContext.default()
        while self.state == "running" and time.monotonic() < deadline:
            while context.pending():
                context.iteration(False)
            time.sleep(0.01)
        if self.state == "running":
            self.fail("PROCESS_TIMEOUT")

    def receipt(self, handle):
        live = self.state in ("running", "termination_unverified")
        result = {"handle": handle, "state": self.state, "running": live, "deliveryState": self.state if live else "completed" if self.state == "completed" else "failed", "duration_limit_seconds": self.duration, "byte_limit": self.limit, "backend": "gstreamer-pulse" if self.kind == "audio" else "gstreamer-pipewire" if self.portal else "gstreamer-x11"}
        if self.state == "termination_unverified":
            result["termination_verified"] = False
        if self.error:
            result["error"] = {"code": self.error, "recoverable": True}
        if self.artifact:
            result["artifact"] = self.artifact
        return result


class DesktopSessions:
    def __init__(self):
        self.portals = {}
        self.recordings = {}
        self.players = {}
        self.capture_resources = []

    def portal(self, remote, input, source_type=1):
        handle = input.get("session_id")
        if handle:
            session = self.portals.get(handle)
            if not session or session.remote != remote or session.source_type != source_type or session.closed:
                raise Failure("FILE_NOT_FOUND")
            return handle, session
        for existing_handle, existing in list(self.portals.items()):
            if existing.closed:
                existing.close()
                del self.portals[existing_handle]
            elif existing.remote == remote and existing.source_type == source_type:
                return existing_handle, existing
        if len(self.portals) >= MAX_HANDLES:
            raise Failure("CONFLICT")
        session = PortalSession(remote, source_type)
        handle = uuid.uuid4().hex
        self.portals[handle] = session
        return handle, session

    def status(self, operation, input):
        if input.get("session_id"):
            portal = self.portals.get(input["session_id"])
            if not portal or operation not in ("input_event", "vision", "screen_record") or portal.remote != (operation == "input_event"):
                raise Failure("FILE_NOT_FOUND")
            return {"session_id": input["session_id"], "ready": not portal.closed, "permissionState": "revoked" if portal.closed else "granted", "backend": "remote-desktop-portal" if portal.remote else "screencast-portal"}
        handle = input.get("handle")
        if handle:
            if operation not in ("audio", "screen_record"):
                raise Failure("FILE_NOT_FOUND")
            recording = self.recordings.get(handle)
            if recording and recording.kind == ("audio" if operation == "audio" else "screen"):
                return recording.receipt(handle)
            player = self.players.get(handle)
            if player and operation == "audio":
                return player.receipt(handle)
            raise Failure("FILE_NOT_FOUND")
        wayland = os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY") and os.environ.get("XDG_SESSION_TYPE") != "x11"
        if operation == "input_event":
            load_gio()
            required = []
            try:
                connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                version = connection.call_sync(PortalSession.destination, PortalSession.path, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.freedesktop.portal.RemoteDesktop", "version")), None, Gio.DBusCallFlags.NONE, 1500, None)
                available = version is not None
            except Exception:
                available = False
        else:
            load_dependencies()
            required = ["pulsesrc", "wavenc", "playbin", "audioconvert", "audioresample", "filesink"] if operation == "audio" else ["pipewiresrc"] if operation == "vision" else ["pipewiresrc" if wayland else "ximagesrc", "openh264enc", "h264parse", "mp4mux", "videoconvert", "videorate", "videoscale", "filesink"]
            available = all(Gst.ElementFactory.find(name) for name in required)
        is_portal = operation in ("input_event", "vision") or "pipewiresrc" in required
        owned_portal = next(((handle, portal) for handle, portal in self.portals.items() if not portal.closed and portal.remote == (operation == "input_event")), None) if is_portal else None
        ready = available and owned_portal is not None
        result = {"available": available, "ready": ready, "backend": "gio-gstreamer", "supportedActions": ACTIONS[operation]}
        if not available:
            result.update({"reason": "dependency_missing", "readinessReason": "dependency_missing"})
        elif is_portal:
            result["permissionState"] = "granted" if ready else "permission_required"
            if ready:
                result["session_id"] = owned_portal[0]
            else:
                result.update({"reason": "portal_session_required", "readinessReason": "portal_session_required"})
        else:
            result.update({"reason": "provider_probe_required", "readinessReason": "provider_probe_required"})
        return result

    def execute(self, operation, action, input):
        if operation == "host" and action == "close":
            if not self.close():
                raise Failure("PROCESS_TIMEOUT")
            return {"closed": True}
        if action == "status":
            return self.status(operation, input)
        if operation == "input_event":
            load_gio()
        else:
            load_dependencies()
        if operation in ("audio", "screen_record"):
            return self.media(operation, action, input)
        if operation == "input_event":
            return self.control(action, input)
        if operation == "vision":
            return self.capture(action, input)
        raise Failure("UNSUPPORTED_PLATFORM")

    def media(self, operation, action, input):
        if action == "stop":
            if operation == "screen_record" and input.get("session_id") and not input.get("handle"):
                portal = self.portals.get(input["session_id"])
                if not portal or portal.remote:
                    raise Failure("FILE_NOT_FOUND")
                for recording in self.recordings.values():
                    if recording.portal is portal:
                        recording.stop(input.get("cancel") == "true")
                        if recording.state == "termination_unverified":
                            raise Failure("PROCESS_TIMEOUT")
                portal.close()
                del self.portals[input["session_id"]]
                return {"session_id": input["session_id"], "closed": True}
            handle = input.get("handle")
            recording = self.recordings.get(handle)
            if recording and recording.kind == ("audio" if operation == "audio" else "screen"):
                recording.stop(input.get("cancel") == "true")
                return recording.receipt(handle)
            player = self.players.get(handle)
            if player and operation == "audio":
                player.stop("cancelled" if input.get("cancel") == "true" else "stopped")
                return player.receipt(handle)
            raise Failure("FILE_NOT_FOUND")
        if len(self.recordings) + len(self.players) >= MAX_HANDLES:
            self.recordings = {key: value for key, value in self.recordings.items() if value.state in ("running", "stopping", "termination_unverified") or value.finished_at is None or time.monotonic() - value.finished_at < 900}
            self.players = {key: value for key, value in self.players.items() if value.state in ("running", "termination_unverified") or value.finished_at is None or time.monotonic() - value.finished_at < 900}
            terminal = [(value.finished_at, collection, key) for collection in (self.recordings, self.players) for key, value in collection.items() if value.state not in ("running", "stopping", "termination_unverified") and value.finished_at is not None and value.resources.closed]
            terminal.sort(key=lambda item: item[0])
            while len(self.recordings) + len(self.players) >= MAX_HANDLES and terminal:
                _, collection, key = terminal.pop(0)
                del collection[key]
            if len(self.recordings) + len(self.players) >= MAX_HANDLES:
                raise Failure("CONFLICT")
        if operation == "audio" and action == "play":
            player = Playback(input)
            handle = uuid.uuid4().hex
            self.players[handle] = player
            return player.receipt(handle)
        if (operation, action) not in (("audio", "record"), ("screen_record", "start")):
            raise Failure("INVALID_INPUT")
        portal = None
        session_id = None
        if operation == "screen_record" and (os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY") and os.environ.get("XDG_SESSION_TYPE") != "x11"):
            session_id, portal = self.portal(False, input)
        recording = Recording("audio" if operation == "audio" else "screen", input, portal)
        handle = uuid.uuid4().hex
        self.recordings[handle] = recording
        receipt = recording.receipt(handle)
        if session_id:
            receipt["session_id"] = session_id
        return receipt

    def control(self, action, input):
        if action == "release_all":
            handle = input.get("session_id")
            if handle and (handle not in self.portals or not self.portals[handle].remote):
                raise Failure("FILE_NOT_FOUND")
            released = []
            for key, portal in list(self.portals.items()):
                if portal.remote and (not handle or handle == key):
                    portal.close()
                    del self.portals[key]
                    released.append(key)
            return {"released": True, "closed": True, "scope": "session" if handle else "owner", "released_session_ids": released}
        if action not in ACTIONS["input_event"] or action == "status":
            raise Failure("UNSUPPORTED_PLATFORM")
        text = input.get("text", "")
        if action == "type_text" and (not text or len(text.encode("utf-8")) > 65536):
            raise Failure("INVALID_INPUT")
        parsed_key = keysym(input.get("key")) if action in ("press_key", "key_down", "key_up") else None
        chord_values = input.get("keys") or (input.get("modifiers", "") + "," + input.get("key", ""))
        chord = [keysym(key) for key in chord_values.replace("+", ",").split(",")] if action == "hotkey" else []
        if len(chord) > 8:
            raise Failure("INVALID_INPUT")
        button = {"left": 272, "middle": 273, "right": 274}.get(input.get("button", "right" if action == "right_click" else "left"))
        if button is None:
            raise Failure("INVALID_INPUT")
        x = bounds(input.get("from.x", input.get("x")), 0, 0, 1_000_000)
        y = bounds(input.get("from.y", input.get("y")), 0, 0, 1_000_000)
        dx = bounds(input.get("delta_x"), 0, -10000, 10000)
        dy = bounds(input.get("delta_y", input.get("delta")), 0, -10000, 10000)
        end_x = bounds(input.get("to.x", input.get("to_x")), x, 0, 1_000_000)
        end_y = bounds(input.get("to.y", input.get("to_y")), y, 0, 1_000_000)
        handle, portal = self.portal(True, input)
        try:
            if action == "type_text":
                for character in text:
                    key = keysym(character)
                    portal.key(key, True)
                    portal.key(key, False)
            elif action in ("press_key", "key_down", "key_up"):
                portal.key(parsed_key, action != "key_up")
                if action == "press_key":
                    portal.key(parsed_key, False)
            elif action == "hotkey":
                try:
                    for key in chord:
                        portal.key(key, True)
                finally:
                    for key in reversed(chord):
                        if key in portal.keys:
                            portal.key(key, False)
            elif action == "scroll":
                portal.notify("NotifyPointerAxis", "(oa{sv}dd)", (dx, dy))
            elif action in ("button_down", "button_up"):
                portal.button(button, action == "button_down")
            else:
                size = portal.properties.get("logical_size", portal.properties.get("size"))
                if not size or x >= size[0] or y >= size[1] or action == "drag" and (end_x >= size[0] or end_y >= size[1]):
                    raise Failure("INVALID_INPUT")
                portal.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (portal.stream, x, y))
                if action != "mouse_move":
                    portal.button(button, True)
                    try:
                        if action == "drag":
                            portal.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (portal.stream, end_x, end_y))
                    finally:
                        portal.button(button, False)
                    if action == "double_click":
                        portal.button(button, True)
                        portal.button(button, False)
        except Exception:
            portal.close()
            self.portals.pop(handle, None)
            raise
        return {"performed": True, "action": action, "backend": "remote-desktop-portal", "session_id": handle, "permissionState": "granted", "coordinate_space": "portal_stream_logical"}

    def capture(self, action, input):
        if self.capture_resources:
            raise Failure("PROCESS_TIMEOUT")
        if action not in ("capture_display", "capture_region", "capture_window"):
            raise Failure("UNSUPPORTED_PLATFORM")
        if any(input.get(name) for name in ("display_id", "window_id", "hwnd", "window_index", "app.window_id", "app.hwnd", "app.window_index", "app.pid", "app.process_id", "app.process_name", "app.name", "app.title")):
            raise Failure("INVALID_INPUT")
        handle, portal = self.portal(False, input, 2 if action == "capture_window" else 1)
        sink = element("appsink", {"max-buffers": 1, "drop": True, "sync": False})
        pipeline = pipeline_for([portal.source(), element("videoconvert"), element("capsfilter", {"caps": Gst.Caps.from_string("video/x-raw,format=RGB")}), sink])
        resources = GstResources(pipeline)
        try:
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise Failure("INTERNAL_ERROR")
            sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
            if sample is None or portal.closed:
                raise Failure("PERMISSION_REQUIRED" if portal.closed else "PROCESS_TIMEOUT")
            info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
            if not info or info.width < 1 or info.height < 1 or info.width > 16384 or info.height > 16384 or info.width * info.height > 64_000_000 or info.stride[0] < info.width * 3 or info.stride[0] > 65536:
                raise Failure("FILE_TOO_LARGE")
            buffer = sample.get_buffer()
            if buffer.get_size() > 256 * 1024 * 1024 or buffer.get_size() < info.stride[0] * info.height:
                raise Failure("FILE_TOO_LARGE")
            data = buffer.extract_dup(0, buffer.get_size())
            pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(data), GdkPixbuf.Colorspace.RGB, False, 8, info.width, info.height, info.stride[0])
            origin_x, origin_y = portal.properties.get("position", (0, 0))
            logical = portal.properties.get("logical_size", portal.properties.get("size", (info.width, info.height)))
            scale_x, scale_y = info.width / logical[0], info.height / logical[1]
            if action == "capture_region":
                x = integer(input.get("region.x", input.get("x")), 0, -1_000_000, 1_000_000)
                y = integer(input.get("region.y", input.get("y")), 0, -1_000_000, 1_000_000)
                width = integer(input.get("region.width", input.get("width")), 0, 1, 16384)
                height = integer(input.get("region.height", input.get("height")), 0, 1, 16384)
                left, top = int((x - origin_x) * scale_x), int((y - origin_y) * scale_y)
                pixel_width, pixel_height = int(width * scale_x), int(height * scale_y)
                if left < 0 or top < 0 or pixel_width < 1 or pixel_height < 1 or left + pixel_width > info.width or top + pixel_height > info.height:
                    raise Failure("INVALID_INPUT")
                pixbuf = pixbuf.new_subpixbuf(left, top, pixel_width, pixel_height)
                origin_x, origin_y = x, y
            success, png = pixbuf.save_to_bufferv("png", [], [])
            if not success or len(png) > MAX_IMAGE_BYTES:
                raise Failure("FILE_TOO_LARGE")
            return {"format": "png", "mime_type": "image/png", "data_base64": base64.b64encode(png).decode("ascii"), "byte_length": len(png), "width": pixbuf.get_width(), "height": pixbuf.get_height(), "origin_x": origin_x, "origin_y": origin_y, "scale_x": scale_x, "scale_y": scale_y, "backend": "screencast-portal", "session_id": handle, "permissionState": "granted"}
        finally:
            if not resources.close():
                self.capture_resources.append(resources)
                raise Failure("PROCESS_TIMEOUT")

    def close(self):
        verified = True
        for recording in self.recordings.values():
            try:
                recording.stop(True)
                if recording.state == "termination_unverified":
                    verified = False
            except Exception:
                verified = False
        for player in self.players.values():
            try:
                player.stop("cancelled")
                if player.state == "termination_unverified":
                    verified = False
            except Exception:
                verified = False
        self.capture_resources = [resources for resources in self.capture_resources if not resources.close()]
        if self.capture_resources:
            verified = False
        retained = {}
        for handle, portal in self.portals.items():
            try:
                portal.close()
            except Exception:
                verified = False
                retained[handle] = portal
        self.portals = retained
        return verified


def run():
    sessions = DesktopSessions()
    parent = os.getppid()
    if os.environ.get("DISPLAY") and os.environ.get("XDG_SESSION_TYPE") != "wayland":
        try:
            import ctypes
            ctypes.CDLL("libX11.so.6").XInitThreads()
        except OSError:
            pass
    try:
        load_gio()
    except Failure:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                value = unavailable_status(request.get("operation"))
                reply = {"ok": True, "value": value} if request.get("action") == "status" else {"ok": False, "error": {"code": "EXECUTABLE_NOT_FOUND"}}
                print(json.dumps(reply, separators=(",", ":")), flush=True)
            except Exception:
                break
        return
    loop = GLib.MainLoop.new(None, False)
    def input_ready(channel, condition):
        request = {}
        line = sys.stdin.readline(16 * 1024 * 1024 + 1)
        if not line or len(line.encode("utf-8")) > 16 * 1024 * 1024:
            sessions.close()
            loop.quit()
            return False
        try:
            request = json.loads(line)
            try:
                result = sessions.execute(request["operation"], request["action"], request["input"])
            except Failure as error:
                if request["action"] != "status" or error.code != "EXECUTABLE_NOT_FOUND":
                    raise
                result = unavailable_status(request["operation"])
            reply = {"ok": True, "value": result}
        except Failure as error:
            reply = {"ok": False, "error": {"code": error.code}}
        except Exception:
            reply = {"ok": False, "error": {"code": "INTERNAL_ERROR"}}
        print(json.dumps(reply, separators=(",", ":")), flush=True)
        if request.get("operation") == "host" and request.get("action") == "close":
            loop.quit()
            return False
        return True
    def parent_alive():
        if os.getppid() != parent:
            sessions.close()
            os._exit(0)
        return True
    def terminate():
        sessions.close()
        os._exit(0)
    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, input_ready)
    GLib.timeout_add(250, parent_alive)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, terminate)
    try:
        loop.run()
    finally:
        sessions.close()


if __name__ == "__main__":
    run()
