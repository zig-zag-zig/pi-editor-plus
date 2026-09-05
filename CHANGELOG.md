# Changelog

## [1.3.1] - 2026-09-02

### Removed
- Alt+Up/Down line-swap: the chord collides with pi's native "restore queued
  messages" binding (`app.message.dequeue`, default `alt+up`). The dequeue
  shortcut works again.
## [1.3.0] - 2026-09-01

### Fixed
- Middle-click paste no longer blocks the event loop (async `exec` instead of `execSync`).
- Caret placement on click / undo / redo / selection-delete is now O(1) direct state access
  instead of synchronous arrow-key replay (previously O(doc) per click — multi-second stalls
  on huge pasted prompts).
- Visual-row computation cached: no more fresh `Intl.Segmenter` per line per render, and
  drag-motion events no longer re-wrap the whole document.
- Fullscreen viewport hook no longer stacks across `/reload` (marker was on the wrong object;
  now on the prototype where it is checked — frozen-prototype-safe inside try/catch).
- Undo/redo history now has a hard 16 MB byte budget in addition to the 300-entry cap,
  so very large prompts cannot pin gigabytes in the pi process.
- Removed dead code after an unreachable `return true` in the click handler.
- Draft no longer double-restores on startup (duplicate factory call removed).
- DEBUG-only hex-dump trace no longer computed on every keystroke when DEBUG is off.

### Changed
- Test harness sessions now use isolated temp agent dirs (prevents the real draft file
  from leaking into test editors).

## [1.2.0] - 2026-08-28

### Added
- Keyboard selection: Shift+arrows, Shift+Home/End, Ctrl+Shift+arrows (word-wise),
  and Ctrl+A (select all). Typing/paste/Enter replaces the selection.
- Double-click selects word, triple-click selects the whole logical line.
- Ctrl+R: fuzzy search through past prompts in the session, applied via overlay picker.
- Draft persistence: the prompt buffer auto-saves (~2.5s debounce) and is recovered
  on the next launch if pi crashed or the draft was never submitted.
- Alt+Up/Down swaps the current line with its neighbor; Ctrl+D duplicates it
  (only when the editor has text — Ctrl+D on empty still exits pi).

### Fixed
- Multi-line selection highlight now paints every visual row of wrapped content
  (chunk-relative column conversion was missing, so continuation rows stayed dark
  while the copied text was correct).

## [1.0.0] - 2026-08-27

### Added
- Click-to-position caret inside pi's prompt editor (regular + fullscreen TUI modes),
  anchored via terminal cursor-position reports (`ESC[6n`) — no upstream patching.
- Drag-to-select editor text with live reverse-video highlight, clipboard copy on
  release, replace-on-type / backspace / delete.
- Undo (`Ctrl+Z`) and redo (`Ctrl+Y`, plus `Ctrl+Shift+Z` where the terminal can
  distinguish it) with time-burst grouping, atomic paste steps, caret restoration,
  and a 300-entry cap. Claims the `Ctrl+Z` chord from suspend-to-background.
- Fullscreen support by wrapping the alt-screen viewport input handler
  (feature-detected; degrades silently to regular-mode-only).
- Forward-compatibility guard: auto-disables itself when pi grows a native
  editor mouse/cursor API ([pi#4928]).
- Debug logging via `PI_EDITOR_PLUS_DEBUG=1` (legacy alias honored).
