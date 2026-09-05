# pi-editor-plus

Mouse support for [pi](https://github.com/earendil-works/pi)'s prompt editor that upstream doesn't have yet:

- **Click to move the caret** anywhere inside the input editor
- **Drag to select** editor text (highlighted), with terminal-style *select = copy* on release
- **Typing / Backspace / Delete** replaces the selection
- Works in **both TUI modes**: `regular` (default) and `fullscreen`

Upstream pi has no mouse API for the editor — the feature request
[earendil-works/pi#4928](https://github.com/earendil-works/pi/issues/4928)
was auto-closed without implementation. This extension adds it from the outside,
without patching pi's source.

Tested against pi `0.84.3`.

## Install

### Option A — npm package (once published)

```bash
pi install npm:pi-editor-plus
```

### Option B — straight from GitHub

```bash
pi install git:github.com/zig-zag-zig/pi-editor-plus
```

### Option C — single file, manual

Copy [`index.ts`](./index.ts) into your extensions directory and restart pi:

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/editor-plus.ts \
  https://raw.githubusercontent.com/zig-zag-zig/pi-editor-plus/main/index.ts
```

No configuration needed. Start pi normally (`pi` for regular mode or
`pi --tui-mode fullscreen`) and click inside the input box.

## Usage

| Action | Effect |
|---|---|
| Left-click in editor | Move caret to clicked position |
| Press, drag, release | Select text (highlighted); copied to clipboard on release |
| Type / Backspace / Delete with selection | Replace / delete selection |
| Arrow keys / Home / End | Clear selection, move caret |
| Double-click / triple-click | Select word / select whole line |
| Shift+arrows, Shift+Home/End, Ctrl+Shift+arrows | Keyboard selection (extends from caret) |
| Ctrl+A | Select all |
| **Ctrl+Z** / **Ctrl+Y** | **Undo** / **redo** (typing bursts collapse to one step) |
| Ctrl+D (editor has text) | Duplicate current line |
| Ctrl+R | Fuzzy-search past prompts, apply picked entry |
| **Ctrl+Z** | **Undo** last edit (typing bursts collapse to one step; pastes and selection-replacements are single steps) |
| **Ctrl+Shift+Z** | **Redo** |

> **Note on Ctrl+Z:** pi binds `Ctrl+Z` to *suspend-to-background*. This extension
> takes that chord over for undo inside the prompt. If you rely on suspending,
> rebind it manually — e.g. `~/.pi/agent/keybindings.json`:
> ```json
> { "app.suspend": ["ctrl+alt+z"] }
> ```
| Click outside the editor | Nothing (transcript keeps native behavior) |

## How it works

- **Click:** enables SGR mouse reporting (`DECSET 1000/1002/1006`), then asks the
  terminal where the caret is via a cursor-position report (`ESC[6n`). The reply
  anchors the editor's visual rows to real terminal rows; the caret is then driven
  with arrow-key inputs that pi's own Editor applies through its wrap/scroll/grapheme
  logic.
- **Drag:** button-motion tracking reports drags while the button is held. The press's
  cursor-report anchors the whole gesture; motion events extend a logical selection;
  release copies it.
- **Highlighting:** reverse-video is injected directly into the editor's rendered lines.
- **Fullscreen:** pi's alt-screen consumes all mouse sequences before extensions can
  see them, so the extension wraps the viewport input handler on the renderer prototype
  (feature-detected). Only left presses inside the editor dock are claimed — transcript
  selection, scrollbar drags, OSC 8 links, wheel scrolling and right-click paste keep
  pi's native behavior.

## Limitations & trade-offs

- In **regular** mode, terminal-native text selection needs **Shift** while mouse
  reporting is on (same trade-off pi makes in fullscreen).
- In **fullscreen**, drags starting inside the editor box select editor text instead of
  transcript text (that is the point).
- Selecting across a collapsed `[paste #N]` marker and deleting it expands the marker
  to its literal content (an upstream `setCursor()`/selection API would fix this).
- Row mapping re-implements pi's word wrap closely but not perfectly; CJK-heavy lines
  may be off by a row/column.
- If you rebind editor cursor keys in `keybindings.json`, synthetic movement follows
  your bindings (removing plain `up/down/left/right` will break caret motion).

## Name history

Originally published as `pi-mouse-caret` (caret-only). With drag-select and
undo/redo onboarded, it outgrew the name; both repository and package are now
`pi-editor-plus`. Old GitHub links redirect automatically.

## Updating pi

The extension is built to age as gracefully as an extension can:

| Pi update changes… | What happens |
|---|---|
| Nothing relevant | Keeps working |
| Internal alt-screen handler renamed (fullscreen hook target) | Fullscreen mouse support silently disables; regular mode unaffected |
| Rendered-line format / word-wrap internals | Selection highlight may drift; click-to-caret usually still fine |
| Public extension APIs (`setEditorComponent`, `onTerminalInput`, `CustomEditor`) | Extension may fail to load — pi shows the load error at startup |

**After every pi update, spend 20 seconds verifying:**

```bash
PI_EDITOR_PLUS_DEBUG=1 pi --no-session
# type something → click → drag → quit (ctrl+c twice / ctrl+d)
cat /tmp/pi-editor-plus.log
```

You want to see `mouse reporting enabled`, `click … -> CPR sent`,
`click (…) cursor={…}`, and no errors. If clicks log but nothing moves, it is the
coordinate mapping (open an issue with the log). If nothing logs at all, input
routing changed upstream.

If your terminal does not answer cursor-position reports (rare), clicks will be
ignored by design — the extension drops presses it cannot anchor.

### When upstream ships native support

On startup the extension checks whether pi's Editor grew a native mouse/cursor API.
When it detects one it notifies ("pi now has native mouse support, extension disabled")
and stays passive. At that point remove the extension:

```bash
pi remove npm:pi-mouse-caret   # if you installed the old-named package
```

## Debugging

```bash
PI_EDITOR_PLUS_DEBUG=1      # writes /tmp/pi-editor-plus.log
```

The log records enabling/disabling, each received click, the CPR round-trip,
computed row/column deltas, final cursor position, and selection ranges.

## Development

Type-check against the installed pi packages (adjust paths if needed):

```bash
bun x tsc --noEmit --strict --skipLibCheck --target es2022 \
  --module nodenext --moduleResolution nodenext \
  --paths '{"@earendil-works/pi-coding-agent":["~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],"@earendil-works/pi-tui":["~/.bun/install/global/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]}' \
  index.ts
```

## License

[MIT](./LICENSE)


## Tests

End-to-end tests drive a real `pi` in a pseudo-terminal and assert on the screen:

```bash
npm test          # == python3 test/run_tests.py
```

Covers: click-to-caret, drag-select + copy toast, double/triple-click, undo/redo,
Ctrl+A, Alt+↑/↓ + Ctrl+D line ops, draft crash-recovery, and middle-click paste.
The Ctrl+R history test self-skips when pi's session loader can't seed history in a
headless environment (it works in a live session with real history).
