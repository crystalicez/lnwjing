import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import unittest
import subprocess
import time

sys.dont_write_bytecode = True
from gi.repository import Gio, GLib

spec = importlib.util.spec_from_file_location("desktop_session", Path(__file__).parents[1] / "src" / "desktop_session.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
native.load_gio()

XML = """<node>
<interface name="org.freedesktop.portal.RemoteDesktop">
<property name="version" type="u" access="read"/>
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyPointerMotionAbsolute"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
<method name="NotifyPointerButton"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyPointerAxis"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
</interface>
<interface name="org.freedesktop.portal.ScreenCast">
<property name="version" type="u" access="read"/>
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="OpenPipeWireRemote"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
</interface>
</node>"""
SESSION_XML = """<node><interface name="org.freedesktop.portal.Session"><method name="Close"/><signal name="Closed"><arg type="a{sv}"/></signal></interface></node>"""
ATSPI_XML = """<node>
<interface name="org.a11y.atspi.Accessible">
<property name="Name" type="s" access="read"/><property name="AccessibleId" type="s" access="read"/>
<method name="GetChildren"><arg type="a(so)" direction="out"/></method>
<method name="GetRoleName"><arg type="s" direction="out"/></method>
</interface>
<interface name="org.a11y.atspi.Action"><property name="NActions" type="i" access="read"/><method name="DoAction"><arg type="i" direction="in"/><arg type="b" direction="out"/></method></interface>
<interface name="org.a11y.atspi.Component"><method name="GrabFocus"><arg type="b" direction="out"/></method></interface>
</node>"""
ATSPI_BUS_XML = """<node><interface name="org.a11y.Bus"><method name="GetAddress"><arg type="s" direction="out"/></method></interface></node>"""


class PortalFixture:
    def __init__(self):
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self.run)
        self.denied = False
        self.events = []
        self.closed = []
        self.last_session = None
        self.error = None
        self.fail_release = False
        self.fail_close = False
        self.identity_mode = None
        self.identity_reads = 0
        self.empty_identity_field = None
        self.thread.start()
        if not self.ready.wait(5):
            raise RuntimeError("Private portal fixture did not start")
        if self.error:
            raise self.error

    def run(self):
        try:
            self.context = GLib.MainContext.new()
            self.context.push_thread_default()
            self.loop = GLib.MainLoop.new(self.context, False)
            self.connection = Gio.DBusConnection.new_for_address_sync(os.environ["DBUS_SESSION_BUS_ADDRESS"], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
            self.connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", GLib.Variant("(su)", (native.PortalSession.destination, 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
            for interface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
                self.connection.register_object(native.PortalSession.path, interface, self.call, self.portal_property, None)
            for name in ("org.a11y.atspi.Registry", "org.a11y.Bus"):
                self.connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", GLib.Variant("(su)", (name, 0)), None, Gio.DBusCallFlags.NONE, 1000, None)
            accessible = Gio.DBusNodeInfo.new_for_xml(ATSPI_XML).interfaces[0]
            self.connection.register_object("/org/a11y/atspi/accessible/root", accessible, self.atspi_call, self.atspi_property, None)
            self.connection.register_object("/org/a11y/bus", Gio.DBusNodeInfo.new_for_xml(ATSPI_BUS_XML).interfaces[0], self.atspi_call, None, None)
            self.app_connection = Gio.DBusConnection.new_for_address_sync(os.environ["DBUS_SESSION_BUS_ADDRESS"], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
            for path in ("/org/a11y/atspi/accessible/root", "/org/a11y/atspi/accessible/save"):
                for interface in Gio.DBusNodeInfo.new_for_xml(ATSPI_XML).interfaces:
                    self.app_connection.register_object(path, interface, self.atspi_call, self.atspi_property, None)
            self.ready.set()
            self.loop.run()
            self.app_connection.close_sync(None)
            self.connection.close_sync(None)
            self.context.pop_thread_default()
        except Exception as error:
            self.error = error
            self.ready.set()

    def atspi_property(self, connection, sender, path, interface, name):
        if name == "NActions":
            return GLib.Variant("i", 1)
        if path.endswith("/save") and name == "Name":
            self.identity_reads += 1
        if path.endswith("/save") and name == self.empty_identity_field:
            return GLib.Variant("s", "")
        if path.endswith("/save") and self.identity_reads > 1:
            if self.identity_mode == "unavailable":
                return None
            if self.identity_mode == name:
                return GLib.Variant("s", "Changed target")
        return GLib.Variant("s", "save-id" if name == "AccessibleId" else "Save ไทย" if path.endswith("/save") else "Native fixture")

    def portal_property(self, connection, sender, path, interface, name):
        return GLib.Variant("u", 2 if interface.endswith("RemoteDesktop") else 6)

    def atspi_call(self, connection, sender, path, interface, method, parameters, invocation):
        if method == "GetAddress":
            invocation.return_value(GLib.Variant("(s)", (os.environ["DBUS_SESSION_BUS_ADDRESS"],)))
        elif method == "GetChildren":
            references = [(self.app_connection.get_unique_name(), "/org/a11y/atspi/accessible/root")] if connection is self.connection else [(self.app_connection.get_unique_name(), "/org/a11y/atspi/accessible/save")] if path.endswith("/root") else []
            invocation.return_value(GLib.Variant("(a(so))", (references,)))
        elif method == "GetRoleName":
            changed = path.endswith("/save") and self.identity_reads > 1 and self.identity_mode == "role"
            invocation.return_value(GLib.Variant("(s)", ("changed role" if changed else "push button" if path.endswith("/save") else "application",)))
        elif method in ("DoAction", "GrabFocus"):
            self.events.append((method, parameters.unpack()))
            invocation.return_value(GLib.Variant("(b)", (True,)))

    def call(self, connection, sender, path, interface, method, parameters, invocation):
        values = parameters.unpack()
        if method == "Close":
            if self.fail_close:
                invocation.return_dbus_error("org.freedesktop.portal.Error.Failed", "Fixture Close refused")
                return
            self.closed.append(path)
            invocation.return_value(GLib.Variant("()", ()))
            return
        if method.startswith("Notify"):
            self.events.append((method, values))
            if self.fail_release and method in ("NotifyKeyboardKeysym", "NotifyPointerButton") and values[-1] == 0:
                invocation.return_dbus_error("org.freedesktop.portal.Error.Failed", "Fixture release refused")
                return
            invocation.return_value(GLib.Variant("()", ()))
            return
        if method == "OpenPipeWireRemote":
            descriptor = os.open("/dev/null", os.O_RDONLY)
            try:
                descriptors = Gio.UnixFDList.new()
                index = descriptors.append(descriptor)
                invocation.return_value_with_unix_fd_list(GLib.Variant("(h)", (index,)), descriptors)
            finally:
                os.close(descriptor)
            return
        options = values[-1]
        token = options["handle_token"]
        request_path = "/org/freedesktop/portal/desktop/request/" + sender.lstrip(":").replace(".", "_") + "/" + token
        result = {}
        if method == "CreateSession":
            self.last_session = "/org/freedesktop/portal/desktop/session/fixture/" + options["session_handle_token"]
            self.connection.register_object(self.last_session, Gio.DBusNodeInfo.new_for_xml(SESSION_XML).interfaces[0], self.call, None, None)
            result["session_handle"] = GLib.Variant("s", self.last_session)
        elif method == "Start":
            result["streams"] = GLib.Variant("a(ua{sv})", [(42, {"size": GLib.Variant("(ii)", (100, 100)), "pipewire-serial": GLib.Variant("t", 999)})])
            if interface.endswith("RemoteDesktop"):
                result["devices"] = GLib.Variant("u", 3)
        self.events.append((method, values))
        connection.emit_signal(sender, request_path, "org.freedesktop.portal.Request", "Response", GLib.Variant("(ua{sv})", (1 if method == "Start" and self.denied else 0, result)))
        invocation.return_value(GLib.Variant("(o)", (request_path,)))

    def revoke(self, path):
        self.connection.emit_signal(None, path, "org.freedesktop.portal.Session", "Closed", GLib.Variant("(a{sv})", ({},)))
        self.connection.flush_sync(None)

    def close(self):
        self.loop.quit()
        self.thread.join(5)
        if self.thread.is_alive():
            raise RuntimeError("Private portal fixture did not stop")


class PortalProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = PortalFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()

    def test_granted_remote_session_uses_typed_dbus_input_and_closes_its_real_fd(self):
        self.fixture.denied = False
        portal = native.PortalSession(True)
        descriptor = portal.fd
        self.assertIsNotNone(descriptor)
        self.assertEqual(portal.properties["pipewire-serial"], 999)
        portal.key(native.keysym("😀"), True)
        portal.key(native.keysym("😀"), False)
        portal.button(272, True)
        portal.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (42, 10.0, 20.0))
        portal.close()
        self.assertTrue(portal.closed)
        self.assertIn(portal.session, self.fixture.closed)
        with self.assertRaises(OSError):
            os.fstat(descriptor)
        self.assertTrue(any(method == "NotifyKeyboardKeysym" and values[2] == native.keysym("😀") for method, values in self.fixture.events))

    def test_denied_start_closes_created_session_and_never_opens_a_stream(self):
        self.fixture.denied = True
        try:
            with self.assertRaises(native.Failure) as result:
                native.PortalSession(False)
            self.assertEqual(result.exception.code, "PERMISSION_REQUIRED")
            self.assertIn(self.fixture.last_session, self.fixture.closed)
        finally:
            self.fixture.denied = False

    def test_revoke_signal_blocks_input_and_closes_fd(self):
        portal = native.PortalSession(True)
        self.fixture.revoke(portal.session)
        context = GLib.MainContext.default()
        import time
        deadline = time.monotonic() + 2
        while not portal.closed and time.monotonic() < deadline:
            while context.pending():
                context.iteration(False)
            time.sleep(0.01)
        self.assertTrue(portal.closed)
        with self.assertRaises(native.Failure):
            portal.key(native.keysym("a"), True)
        portal.close()
        self.assertIsNone(portal.fd)

    def test_real_dbus_release_failure_still_closes_session_and_fd(self):
        portal = native.PortalSession(True)
        descriptor = portal.fd
        portal.key(native.keysym("a"), True)
        portal.button(272, True)
        self.fixture.fail_release = True
        try:
            portal.close()
            self.assertTrue(portal.closed)
            self.assertIn(portal.session, self.fixture.closed)
            with self.assertRaises(OSError):
                os.fstat(descriptor)
        finally:
            self.fixture.fail_release = False

    def test_real_dbus_close_failure_is_unverified_and_retry_remains_owned(self):
        portal = native.PortalSession(False)
        self.fixture.fail_close = True
        try:
            with self.assertRaises(native.Failure) as response:
                portal.close()
            self.assertEqual(response.exception.code, "PROCESS_TIMEOUT")
            self.assertFalse(portal.closed)
            self.assertIsNotNone(portal.session)
            self.assertIsNone(portal.fd)
        finally:
            self.fixture.fail_close = False
            portal.close()
        self.assertTrue(portal.closed)

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_actual_native_ipc_fences_foreign_owners_and_eof_stops_owned_helpers(self):
        environment = dict(os.environ, XDG_SESSION_TYPE="wayland", WAYLAND_DISPLAY="fixture-only")
        process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        request_id = 0
        def call(action, client="client", session="session", workspace="workspace", parameters=None):
            nonlocal request_id
            request_id += 1
            owner = {"clientId": client, "sessionId": session}
            if workspace is not None:
                owner["workspaceId"] = workspace
            request = {"id": str(request_id), "operation": "input_event", "input": {"action": action, "metadata": {"lnwjing.taskOwner.v1": owner}, "parameters": parameters or {}}}
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            import select
            ready, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(ready, "Native provider did not answer bounded fixture input")
            return json.loads(process.stdout.readline())
        try:
            self.fixture.denied = False
            readiness = call("status")
            self.assertTrue(readiness["value"]["available"])
            self.assertFalse(readiness["value"]["ready"])
            self.assertEqual(readiness["value"]["permissionState"], "permission_required")
            started = call("type_text", parameters={"text": " ไทย😀 "})
            self.assertTrue(started["ok"], started)
            handle = started["value"]["session_id"]
            granted_readiness = call("status")
            self.assertTrue(granted_readiness["value"]["ready"])
            self.assertEqual(granted_readiness["value"]["permissionState"], "granted")
            self.assertEqual(granted_readiness["value"]["session_id"], handle)
            children = Path("/proc/%d/task/%d/children" % (process.pid, process.pid)).read_text().split()
            self.assertTrue(children)
            for client, session, workspace in (("foreign", "session", "workspace"), ("client", "foreign", "workspace"), ("client", "session", "foreign")):
                for action in ("status", "release_all"):
                    denied = call(action, client, session, workspace, {"session_id": handle})
                    self.assertFalse(denied["ok"])
                    self.assertEqual(denied["error"]["code"], "FILE_NOT_FOUND")
            status = call("status", workspace=None, parameters={"session_id": handle})
            self.assertEqual(status["value"]["permissionState"], "granted")
            stopped = call("release_all", parameters={"session_id": handle})
            self.assertTrue(stopped["value"]["closed"])
            self.assertEqual(stopped["value"]["released_session_ids"], [handle])
            self.assertEqual(stopped["value"]["scope"], "session")
            closed_status = call("status", parameters={"session_id": handle})
            self.assertFalse(closed_status["ok"])
            self.assertEqual(closed_status["error"]["code"], "FILE_NOT_FOUND")
            for number in range(40):
                started = call("type_text", parameters={"text": "a"})
                self.assertTrue(started["ok"], started)
                current = started["value"]["session_id"]
                released = call("release_all", parameters={"session_id": current} if number % 2 else {})["value"]
                self.assertTrue(released["closed"])
                self.assertEqual(released["released_session_ids"], [current])
                self.assertEqual(released["scope"], "session" if number % 2 else "owner")
                self.assertFalse(call("status", parameters={"session_id": current})["ok"])
            process.stdin.close()
            process.wait(timeout=5)
            for pid in children:
                self.assertFalse(Path("/proc/" + pid).exists(), "EOF left an owned native helper process")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_unverified_portal_cleanup_terminates_only_the_affected_owner_helper(self):
        environment = dict(os.environ, XDG_SESSION_TYPE="wayland", WAYLAND_DISPLAY="fixture-only")
        process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        def call(action, owner, parameters):
            process.stdin.write(json.dumps({"id": owner + action, "operation": "input_event", "input": {"action": action, "metadata": {"lnwjing.taskOwner.v1": {"clientId": "client", "sessionId": owner, "workspaceId": "workspace"}}, "parameters": parameters}}) + "\n")
            process.stdin.flush()
            import select
            ready, _, _ = select.select([process.stdout], [], [], 6)
            self.assertTrue(ready)
            return json.loads(process.stdout.readline())
        def children():
            return set(Path("/proc/%d/task/%d/children" % (process.pid, process.pid)).read_text().split())
        try:
            first = call("type_text", "first", {"text": "a"})["value"]["session_id"]
            first_children = children()
            second = call("type_text", "second", {"text": "a"})["value"]["session_id"]
            second_children = children() - first_children
            self.assertEqual(len(first_children), 1)
            self.assertEqual(len(second_children), 1)
            self.fixture.fail_close = True
            failed = call("release_all", "first", {"session_id": first})
            self.assertFalse(failed["ok"], failed)
            self.assertEqual(failed["error"]["code"], "PROCESS_TIMEOUT")
            self.assertTrue(all(not Path("/proc/" + pid).exists() for pid in first_children))
            self.assertTrue(all(Path("/proc/" + pid).exists() for pid in second_children))
            self.fixture.fail_close = False
            self.assertEqual(call("status", "second", {"session_id": second})["value"]["permissionState"], "granted")
            self.assertFalse(call("status", "first", {"session_id": first})["ok"])
            process.stdin.close()
            process.wait(timeout=5)
        finally:
            self.fixture.fail_close = False
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_abrupt_native_host_exit_closes_the_owned_portal_helper(self):
        environment = dict(os.environ, XDG_SESSION_TYPE="wayland", WAYLAND_DISPLAY="fixture-only")
        process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        try:
            process.stdin.write(json.dumps({"id": "start", "operation": "input_event", "input": {"action": "type_text", "parameters": {"text": "a"}, "metadata": {"lnwjing.taskOwner.v1": {"clientId": "client", "sessionId": "death", "workspaceId": "workspace"}}}}) + "\n")
            process.stdin.flush()
            import select
            ready, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(ready)
            started = json.loads(process.stdout.readline())
            self.assertTrue(started["ok"], started)
            children = Path("/proc/%d/task/%d/children" % (process.pid, process.pid)).read_text().split()
            self.assertTrue(children)
            portal = self.fixture.last_session
            process.kill()
            process.wait(timeout=5)
            deadline = time.monotonic() + 3
            while portal not in self.fixture.closed and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIn(portal, self.fixture.closed)
            for pid in children:
                status = Path("/proc/" + pid + "/stat")
                def terminal():
                    try:
                        return status.read_text().split(")", 1)[1].strip().startswith("Z")
                    except FileNotFoundError:
                        return True
                while not terminal() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(terminal(), "Parent death left a live native helper")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_actual_atspi_finds_clicks_and_focuses_the_application_owned_object(self):
        environment = dict(os.environ)
        environment.pop("AT_SPI_BUS_ADDRESS", None)
        process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        try:
            for action in ("find_element", "click", "focus"):
                process.stdin.write(json.dumps({"id": action, "operation": "accessibility", "input": {"action": action, "parameters": {"name": "Save ไทย", "automation_id": "save-id", "max_items": 10, "max_depth": 4}}}) + "\n")
                process.stdin.flush()
                import select
                ready, _, _ = select.select([process.stdout], [], [], 5)
                self.assertTrue(ready, "AT-SPI fixture query did not complete")
                response = json.loads(process.stdout.readline())
                self.assertTrue(response["ok"], response)
                self.assertEqual(response["value"]["element"]["bus_name"], self.fixture.app_connection.get_unique_name())
                self.assertEqual(response["value"]["element"]["name"], "Save ไทย")
                self.assertEqual(response["value"]["performed"], action != "find_element")
            self.assertTrue(any(method == "DoAction" for method, values in self.fixture.events))
            self.assertTrue(any(method == "GrabFocus" for method, values in self.fixture.events))
            process.stdin.close()
            process.wait(timeout=5)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_actual_atspi_accepts_stable_name_only_and_id_only_identity(self):
        for empty in ("AccessibleId", "Name"):
            self.fixture.empty_identity_field = empty
            selectors = {"name": "Save ไทย"} if empty == "AccessibleId" else {"automation_id": "save-id"}
            for action in ("find_element", "click", "focus"):
                self.fixture.identity_reads = 0
                before = sum(method in ("DoAction", "GrabFocus") for method, _ in self.fixture.events)
                process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(os.environ))
                try:
                    process.stdin.write(json.dumps({"id": "stable", "operation": "accessibility", "input": {"action": action, "parameters": {**selectors, "role": "push button", "max_items": 10, "max_depth": 4}}}) + "\n")
                    process.stdin.flush()
                    import select
                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                    response = json.loads(process.stdout.readline())
                    self.assertTrue(response["ok"], response)
                    self.assertIsNone(response["value"]["element"]["automation_id" if empty == "AccessibleId" else "name"])
                    self.assertEqual(before + (action != "find_element"), sum(method in ("DoAction", "GrabFocus") for method, _ in self.fixture.events))
                    process.stdin.close()
                    process.wait(timeout=5)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    if not process.stdin.closed:
                        process.stdin.close()
                    process.stdout.close()
                    process.stderr.close()
            self.fixture.empty_identity_field = None

    @unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Run against the compiled Linux native binary")
    def test_actual_atspi_refuses_changed_or_unavailable_identity_before_mutation(self):
        for mode in ("Name", "AccessibleId", "role", "unavailable"):
            for action in ("click", "focus"):
                self.fixture.identity_mode = mode
                self.fixture.identity_reads = 0
                before = sum(method in ("DoAction", "GrabFocus") for method, _ in self.fixture.events)
                process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(os.environ))
                try:
                    process.stdin.write(json.dumps({"id": "changed", "operation": "accessibility", "input": {"action": action, "parameters": {"name": "Save ไทย", "automation_id": "save-id", "max_items": 10, "max_depth": 4}}}) + "\n")
                    process.stdin.flush()
                    import select
                    ready, _, _ = select.select([process.stdout], [], [], 5)
                    self.assertTrue(ready)
                    response = json.loads(process.stdout.readline())
                    self.assertFalse(response["ok"], response)
                    self.assertIn(response["error"]["code"], ("CONFLICT", "PERMISSION_REQUIRED"))
                    self.assertEqual(before, sum(method in ("DoAction", "GrabFocus") for method, _ in self.fixture.events))
                    process.stdin.close()
                    process.wait(timeout=5)
                finally:
                    self.fixture.identity_mode = None
                    self.fixture.identity_reads = 0
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    process.stdout.close()
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()
