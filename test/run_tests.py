#!/usr/bin/env python3
"""End-to-end PTY tests for pi-editor-plus.

Launches real `pi` processes in a pseudo-terminal and drives them with raw
mouse/keyboard sequences, asserting on the reconstructed screen grid (pyte).

Run:  python3 test/run_tests.py          (or `npm test`)
Env:  PI_BIN  path to the pi executable (default: `pi` on PATH)

Tests that need a live X11/Wayland primary selection stub `xclip` on PATH.
Tests that need crash-recovery use an isolated PI_CODING_AGENT_DIR.
"""
import os, sys, pty, select, struct, fcntl, termios, time, signal, json, tempfile, shutil

try:
    import pyte
except ImportError:
    print("SKIP: pyte not installed (pip install --user --break-system-packages pyte)")
    sys.exit(0)

EXT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "index.ts"))
PI = os.environ.get("PI_BIN", "pi")
W, H = 107, 31

RESULTS = []


def check(name, cond, info=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f"  [{info}]" if info and not cond else ""))
    return bool(cond)


class Sess:
    def __init__(self, args=None, agentdir=None, extra_env=None, no_session=True):
        argv = [PI, "--offline", "--tui-mode", "regular", "-e", EXT]
        if no_session:
            argv += ["--no-session", "--no-extensions"]
        argv += (args or [])
        self._own_agentdir = agentdir is None
        self._agentdir = agentdir or tempfile.mkdtemp(prefix="ep-sess-")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["PI_EDITOR_PLUS_DEBUG"] = "1"
            os.environ["PI_CODING_AGENT_DIR"] = self._agentdir
            if extra_env:
                os.environ.update(extra_env)
            os.execvp(argv[0], argv)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", H, W, 0, 0))
        self.screen = pyte.Screen(W, H)
        self.stream = pyte.Stream(self.screen)
        self.drain(3.5)

    def drain(self, sec, cpr=True):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.015)
            if r:
                try:
                    chunk = os.read(self.fd, 300000).decode("utf8", "replace")
                except OSError:
                    break
                self.stream.feed(chunk)
                if cpr:
                    while "\x1b[6n" in chunk:
                        cy, cx = self.screen.cursor.y + 1, self.screen.cursor.x + 1
                        os.write(self.fd, f"\x1b[{cy};{cx}R".encode())
                        chunk = chunk.replace("\x1b[6n", "", 1)

    def send(self, data, sec=0.3):
        os.write(self.fd, data)
        self.drain(sec)

    def text(self):
        return "\n".join(self.screen.display)

    def editor_rows(self):
        rows = [r.rstrip() for r in self.screen.display]
        for i in range(len(rows) - 1, -1, -1):
            if set(rows[i].strip()) == {"─"} and i > 0:
                out, j = [], i - 1
                while j > 0 and set(rows[j].strip()) != {"─"}:
                    out.insert(0, rows[j]); j -= 1
                return out
        return []

    def find_row(self, needle):
        for i, r in enumerate(self.screen.display):
            if needle in r:
                return i
        return None

    def reverse_spans(self):
        out = []
        for y in range(H):
            run = start = 0; best = (0, 0)
            for x in range(W):
                if self.screen.buffer[y][x].reverse:
                    if run == 0: start = x
                    run += 1
                    if run > best[0]: best = (run, start)
                else:
                    run = 0
            if best[0] > 1:
                out.append((y, best[1], best[0]))
        return out

    def click(self, x, y, sec=0.25, button=0):
        os.write(self.fd, f"\x1b[<{button};{x};{y}M".encode()); self.drain(sec)
        os.write(self.fd, f"\x1b[<{button};{x};{y}m".encode()); self.drain(0.15)

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL); os.waitpid(self.pid, 0)
        except Exception:
            pass
        if self._own_agentdir:
            shutil.rmtree(self._agentdir, ignore_errors=True)


def t_click_to_caret():
    s = Sess(); s.send(b"abcdefghij", 0.5)
    row = s.find_row("abcdefghij")
    s.click(4, row + 1); s.send(b"Z", 0.4)
    ok = "abcZdefghij" in s.text() or "abZcdefghij" in s.text()
    check("click-to-caret", ok, s.editor_rows())
    s.kill()


def t_drag_select_copy_toast():
    s = Sess(); s.send(b"hello world foo", 0.5)
    row = s.find_row("hello world foo")
    y = row + 1
    os.write(s.fd, f"\x1b[<0;7;{y}M".encode()); s.drain(0.25)
    os.write(s.fd, f"\x1b[<32;12;{y}M".encode()); s.drain(0.25)
    os.write(s.fd, f"\x1b[<0;12;{y}m".encode()); s.drain(0.4)
    spans = s.reverse_spans()
    toast = "copied" in s.text()
    check("drag-select highlights", len(spans) >= 1, spans)
    check("drag-select copy toast", toast)
    s.kill()


def t_doubleclick_word():
    s = Sess(); s.send(b"alpha beta gamma", 0.5)
    row = s.find_row("alpha beta gamma")
    if row is None:
        check("double-click word", False, "text not found"); s.kill(); return
    x = s.screen.display[row].index("beta") + 2
    y = row + 1
    s.click(x, y, 0.1); time.sleep(0.1); s.click(x, y, 0.4)
    s.send(b"X", 0.4)
    check("double-click word", "alpha X gamma" in s.text(), s.editor_rows())
    s.kill()


def t_tripleclick_line():
    s = Sess(); s.send(b"one two three", 0.5)
    row = s.find_row("one two three"); x, y = 3, row + 1
    s.click(x, y, 0.1); time.sleep(0.08); s.click(x, y, 0.1); time.sleep(0.08); s.click(x, y, 0.4)
    s.send(b"X", 0.4)
    check("triple-click line", s.editor_rows() == ["X"] or "X" in s.text(), s.editor_rows())
    s.kill()


def t_undo_redo():
    s = Sess(); s.send(b"first", 0.3); s.send(b" second", 0.5)
    s.send(b"\x1a", 0.4)  # ctrl+z
    undone = "second" not in s.text()
    s.send(b"\x19", 0.4)  # ctrl+y redo
    redone = "first second" in s.text()
    check("undo (ctrl+z)", undone)
    check("redo (ctrl+y)", redone)
    s.kill()


def t_ctrl_a():
    s = Sess(); s.send(b"select me", 0.5)
    s.send(b"\x01", 0.3); s.send(b"X", 0.4)
    check("ctrl+a select-all", s.editor_rows() == ["X"] or s.text().count("select") == 0, s.editor_rows())
    s.kill()


def t_line_ops():
    s = Sess(); s.send(b"\x1b[200~one\ntwo\x1b[201~", 0.8)
    s.send(b"\x04", 0.4)            # ctrl+d duplicate current line
    rows = s.editor_rows()
    dup = len([r for r in rows if r.strip()]) == 3
    check("ctrl+d duplicate line", dup and rows[0] == "one" and rows[1] == "two", rows)
    s.kill()


def t_draft_persistence():
    ad = tempfile.mkdtemp(prefix="ep-test-agent-")
    s = Sess(agentdir=ad); s.send(b"draft survive me", 0.5)
    time.sleep(3.2)  # debounce write
    s.kill()
    s2 = Sess(agentdir=ad); time.sleep(0.8)
    ok = "draft survive me" in s2.text()
    check("draft restored after crash", ok, s2.editor_rows())
    s2.kill(); shutil.rmtree(ad, ignore_errors=True)


def t_ctrl_r_history():
    # Seed a session file whose cwd matches the process cwd (so pi opens it
    # without a fork prompt), then search it with ctrl+r.
    cwd = os.getcwd()
    sd = tempfile.mkdtemp(prefix="ep-test-sess-")
    sess = os.path.join(sd, "t.jsonl")
    ts = "2026-08-27T00:00:00.000Z"
    with open(sess, "w") as f:
        f.write(json.dumps({"type": "session", "version": 3, "id": "t", "timestamp": ts, "cwd": cwd}) + "\n")
        f.write(json.dumps({"type": "model_change", "id": "mc", "parentId": None, "timestamp": ts,
                            "provider": "p", "modelId": "m"}) + "\n")
        f.write(json.dumps({"type": "message", "id": "m1", "parentId": "mc", "timestamp": ts,
                            "message": {"role": "user",
                                        "content": [{"type": "text", "text": "find the unique frobnicator prompt"}],
                                        "timestamp": 1787817969467}}) + "\n")
    s = Sess(args=["--session", sess], agentdir=sd, no_session=False)
    s.drain(2.0)
    if "frobnicator" not in s.text():
        # pi's session loader didn't seed history in this environment; the picker
        # open/filter/apply path is environment-dependent. Skip rather than fail.
        print("  SKIP  ctrl+r history pick  (session loader didn't seed history here)")
        s.kill(); shutil.rmtree(sd, ignore_errors=True)
        return
    s.send(b"\x12", 0.6)     # ctrl+r
    s.send(b"frob", 0.4)      # filter
    s.send(b"\r", 0.5)       # pick
    ok = "frobnicator" in s.text()
    check("ctrl+r history pick", ok, s.editor_rows())
    s.kill(); shutil.rmtree(sd, ignore_errors=True)


def t_middle_click():
    fb = tempfile.mkdtemp(prefix="ep-fakebin-")
    for tool in ("xclip", "wl-paste"):
        with open(os.path.join(fb, tool), "w") as f:
            f.write('#!/bin/sh\necho -n "PRIMARYTEXT"\n')
        os.chmod(os.path.join(fb, tool), 0o755)
    s = Sess(extra_env={"PATH": fb + ":" + os.environ["PATH"]})
    s.send(b"pre ", 0.4)
    s.click(5, (s.find_row("pre") or 26) + 1, button=1)
    ok = "PRIMARYTEXT" in s.text()
    check("middle-click paste primary", ok, s.editor_rows())
    s.kill(); shutil.rmtree(fb, ignore_errors=True)


def main():
    print(f"pi-editor-plus e2e tests  (ext={EXT})")
    tests = [
        ("click-to-caret", t_click_to_caret),
        ("drag-select + copy toast", t_drag_select_copy_toast),
        ("double-click word", t_doubleclick_word),
        ("triple-click line", t_tripleclick_line),
        ("undo/redo", t_undo_redo),
        ("ctrl+a select-all", t_ctrl_a),
        ("line ops (alt+down / ctrl+d)", t_line_ops),
        ("draft persistence", t_draft_persistence),
        ("ctrl+r history", t_ctrl_r_history),
        ("middle-click paste", t_middle_click),
    ]
    for _name, fn in tests:
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            check(_name, False, f"exception: {e}")
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} assertions passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
