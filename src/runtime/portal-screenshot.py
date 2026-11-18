"""Request a screenshot from the current desktop session's portal."""

import json
import os
import signal
import stat
import sys
import uuid
from urllib.parse import unquote, urlsplit

PORTAL = "org.freedesktop.portal.Desktop"
DESKTOP = "/org/freedesktop/portal/desktop"
REQUEST = "org.freedesktop.portal.Request"
LIMIT = 32 * 1024 * 1024


def capture(target, timeout):
    try:
        from gi.repository import Gio, GLib
    except ImportError:
        return {"ok": False, "code": "portal-runtime-missing"}

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    sender = bus.get_unique_name()[1:].replace(".", "_")
    token = "irmia_" + uuid.uuid4().hex
    handle = f"{DESKTOP}/request/{sender}/{token}"
    loop = GLib.MainLoop()
    response = None

    def receive(_bus, _sender, _path, _interface, _signal, args):
        nonlocal response
        response = args.unpack()
        loop.quit()

    def stop():
        loop.quit()
        return GLib.SOURCE_REMOVE

    subscription = bus.signal_subscribe(
        PORTAL, REQUEST, "Response", handle, None, Gio.DBusSignalFlags.NONE, receive
    )
    options = {
        "handle_token": GLib.Variant("s", token),
        "interactive": GLib.Variant("b", True),
    }
    deadline = GLib.get_monotonic_time() + timeout * 1000
    returned_handle, = bus.call_sync(
        PORTAL, DESKTOP, "org.freedesktop.portal.Screenshot", "Screenshot",
        GLib.Variant("(sa{sv})", ("", options)), GLib.VariantType.new("(o)"),
        Gio.DBusCallFlags.NONE, min(timeout, 5000), None,
    ).unpack()
    # handle_token is normally honored, but the portal is allowed to return a
    # different object path. Follow the path it actually returned instead of
    # waiting forever on the predicted one.
    if returned_handle != handle:
        bus.signal_unsubscribe(subscription)
        subscription = bus.signal_subscribe(
            PORTAL, REQUEST, "Response", returned_handle, None, Gio.DBusSignalFlags.NONE, receive
        )
    if response is None:
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, stop)
        GLib.timeout_add(max(1, (deadline - GLib.get_monotonic_time()) // 1000), stop)
        loop.run()
    bus.signal_unsubscribe(subscription)
    if response is None:
        try:
            bus.call_sync(PORTAL, returned_handle, REQUEST, "Close", None, None,
                          Gio.DBusCallFlags.NONE, 500, None)
        except GLib.Error:
            pass
        return {"ok": False, "code": "portal-timeout"}
    status, results = response
    if status != 0:
        return {"ok": False, "code": "portal-cancelled" if status == 1 else "portal-unavailable"}
    uri = urlsplit(results.get("uri", ""))
    if uri.scheme != "file" or uri.netloc or not uri.path.startswith("/"):
        return {"ok": False, "code": "portal-invalid-output"}
    fd = os.open(unquote(uri.path), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        facts = os.fstat(source.fileno())
        if not stat.S_ISREG(facts.st_mode) or not 24 <= facts.st_size <= LIMIT:
            return {"ok": False, "code": "portal-invalid-output"}
        image = source.read(LIMIT + 1)
    if len(image) < 24 or len(image) > LIMIT or not image.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"ok": False, "code": "portal-invalid-output"}
    with open(target, "xb") as output:
        output.write(image)
    return {"ok": True}


if __name__ == "__main__":
    try:
        print(json.dumps(capture(sys.argv[1], int(sys.argv[2]))))
    except Exception:
        print(json.dumps({"ok": False, "code": "portal-unavailable"}))
