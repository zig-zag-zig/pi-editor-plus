# Changelog

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
