# This file is created by the Ren'Py Launch and Sync Visual Studio Code
# extension. It can be safely be deleted if you do not want to use the features
# provided by the extension.
#
# This file should not be checked into source control.
#

from time import sleep
import textwrap
import threading
import json
import functools
import re
import os

import renpy  # type: ignore

ENABLED = bool(os.getenv("WARP_ENABLED"))
PORT = os.getenv("WARP_WS_PORT")
NONCE = os.getenv("WARP_WS_NONCE")


def py_exec(text: str):
    while renpy.exports.is_init_phase():
        print("in init phase, waiting...")
        sleep(0.2)

    fn = functools.partial(renpy.python.py_exec, text)
    renpy.exports.invoke_in_main_thread(fn)


def socket_listener(websocket):
    """listens for messages from the socket server"""
    for message in websocket:
        payload = json.loads(message)

        print("socket <", message)

        if payload["type"] == "warp_to_line":
            file = payload["file"]
            line = payload["line"]

            py_exec(f"renpy.warp_to_line('{file}:{line}')")

        elif payload["type"] == "set_autoreload":
            script = textwrap.dedent("""
                if renpy.get_autoreload() == False:
                    renpy.set_autoreload(True)
                    renpy.reload_script()
            """)
            py_exec(script)

        else:
            print(f"unhandled message type '{payload['type']}'")


def socket_producer(websocket):
    """produces messages to the socket server"""

    first = True

    # report current line to warp server
    def fn(event, interact=True, **kwargs):
        nonlocal first

        if not interact:
            return

        if event == "begin":
            # skip the first event, as it usually is not useful
            if first:
                first = False
                return

            filename, line = renpy.exports.get_filename_line()
            relative_filename = re.sub(r"^game/", "", filename)
            filename_abs = os.path.join(
                renpy.config.gamedir, relative_filename)

            message = json.dumps(
                {
                    "type": "current_line",
                    "line": line,
                    "path": filename_abs,
                    "relative_path": relative_filename,
                }
            )

            print("socket >", message)
            websocket.send(message)

    renpy.config.all_character_callbacks.append(fn)


def renpy_warp_service():
    from websockets.sync.client import connect  # type: ignore
    from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError  # type: ignore

    try:
        with connect(
            f"ws://localhost:{PORT}",
            additional_headers={"nonce": NONCE},
            open_timeout=5,
            close_timeout=5,
        ) as websocket:
            print("connected to renpy warp socket server")

            def quit():
                print("closing websocket connection")
                websocket.close()

            renpy.config.quit_callbacks.append(quit)

            socket_producer(websocket)
            socket_listener(websocket)  # this blocks until socket is closed

    except ConnectionClosedOK:
        print("connection closed by renpy warp socket server")
        pass

    except ConnectionClosedError as e:
        print("connection to renpy warp socket server closed unexpectedly", e)
        sleep(1)
        return renpy_warp_service()

    except ConnectionRefusedError:
        print(f"no renpy warp socket server on {PORT}. retrying in 1s...")
        sleep(1)
        return renpy_warp_service()

    print("renpy warp script exiting")


@functools.lru_cache(maxsize=1)  # only run once
def start_renpy_warp_service():
    if ENABLED and renpy.config.developer:
        renpy_warp_thread = threading.Thread(target=renpy_warp_service)
        renpy_warp_thread.daemon = True
        renpy_warp_thread.start()

        print("renpy warp script started")


renpy.config.after_default_callbacks.append(start_renpy_warp_service)
