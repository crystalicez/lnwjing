import json
import os
import select
import socket
import struct
import subprocess
import threading
import unittest


class CaptureDisplay:
    def __init__(self, refuse_image):
        self.refuse_image = refuse_image
        self.images = 0
        self.connections = 0
        self.errors = []
        self.closed = threading.Event()
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.listener.settimeout(0.1)
        self.display = "127.0.0.1:" + str(self.listener.getsockname()[1] - 6000)
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def read(self, connection, length):
        result = bytearray()
        while len(result) < length:
            chunk = connection.recv(length - len(result))
            if not chunk:
                return None
            result.extend(chunk)
        return bytes(result)

    def setup(self, order):
        pack = lambda fmt, *values: struct.pack(order + fmt, *values)
        header = pack("IIIIHHBBBBBBBB4x", 1, 0x100000, 0xFFFFF, 0, 0, 65535, 1, 1, 0, 0, 32, 32, 8, 255)
        format = pack("BBB5x", 24, 32, 32)
        screen = pack("IIIIIHHHHHHIBBBB", 0x100, 0x101, 0xFFFFFF, 0, 0, 64, 64, 17, 17, 1, 1, 0x102, 0, 0, 24, 1)
        depth = pack("BxH4x", 24, 1)
        visual = pack("IBBHIIII", 0x102, 4, 8, 256, 0xFF0000, 0xFF00, 0xFF, 0)
        body = header + format + screen + depth + visual
        return pack("BBHHH", 1, 0, 11, 0, len(body) // 4) + body

    def serve(self, connection):
        connection.settimeout(2)
        hello = self.read(connection, 12)
        if hello is None:
            return
        order = "<" if hello[0] == ord("l") else ">"
        auth_name, auth_data = struct.unpack_from(order + "HH", hello, 6)
        self.read(connection, (auth_name + 3) // 4 * 4 + (auth_data + 3) // 4 * 4)
        connection.sendall(self.setup(order))
        self.connections += 1
        sequence = 0
        while not self.closed.is_set():
            header = self.read(connection, 4)
            if header is None:
                return
            length = struct.unpack_from(order + "H", header, 2)[0] * 4
            if length < 4 or length > 65536:
                raise RuntimeError("Fixture received an invalid bounded request")
            payload = self.read(connection, length - 4)
            if payload is None:
                return
            sequence += 1
            opcode = header[0]
            if opcode == 73:
                self.images += 1
                if self.refuse_image:
                    connection.sendall(struct.pack(order + "BBHIHB21x", 0, 10, sequence, 0x100, 0, opcode))
                else:
                    connection.sendall(struct.pack(order + "BBHII20x", 1, 24, sequence, 1, 0x102) + b"\x20\x40\x80\0")
            elif opcode == 43:
                connection.sendall(struct.pack(order + "BBHII20x", 1, 0, sequence, 0, 0x100))
            elif opcode == 98:
                connection.sendall(struct.pack(order + "BBHI24x", 1, 0, sequence, 0))
            else:
                raise RuntimeError("Unexpected fixture X11 opcode " + str(opcode))

    def run(self):
        while not self.closed.is_set():
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                with connection:
                    self.serve(connection)
            except (ConnectionError, socket.timeout):
                pass
            except Exception as error:
                self.errors.append(str(error))

    def close(self):
        self.closed.set()
        self.listener.close()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise RuntimeError("Owned display fixture did not stop")


@unittest.skipUnless(os.environ.get("LNWJING_NATIVE_TEST_BIN"), "Requires the compiled Linux native binary")
class X11ReadinessTests(unittest.TestCase):
    def test_direct_status_probes_pixels_and_refuses_a_connected_display_without_getimage(self):
        for refuse in (True, False):
            display = CaptureDisplay(refuse)
            self.addCleanup(display.close)
            environment = dict(os.environ, DISPLAY=display.display, XDG_SESSION_TYPE="x11")
            environment.pop("WAYLAND_DISPLAY", None)
            environment.pop("XAUTHORITY", None)
            process = subprocess.Popen([os.environ["LNWJING_NATIVE_TEST_BIN"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
            try:
                process.stdin.write(json.dumps({"id": "pixels", "operation": "vision", "input": {"action": "status"}}) + "\n")
                process.stdin.flush()
                self.assertTrue(select.select([process.stdout], [], [], 5)[0], "Owned X11 display did not answer native status")
                reply = json.loads(process.stdout.readline())
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(reply["value"]["ready"], not refuse, reply)
                self.assertEqual(display.images, 1, "Status did not issue the actual bounded GetImage probe")
                self.assertGreaterEqual(display.connections, 2)
                self.assertEqual(display.errors, [])
                process.stdin.close()
                process.wait(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
