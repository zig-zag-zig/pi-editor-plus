/**
 * pi-editor-plus v1.3.0 — mouse click-to-caret AND drag-to-select for pi's
 * prompt editor, in regular and fullscreen TUI modes.
 *
 * Formerly published as pi-mouse-caret (repo renamed; old links redirect).
 *
 *
 * Upstream pi (incl. main) has no mouse API for the editor (see
 * earendil-works/pi#4928, auto-closed). This extension implements both
 * features without upstream support:
 *
 *  - Click: ask the terminal where the caret is (CPR, ESC[6n). The reply
 *    anchors the editor's visual rows to real terminal rows - no fragile
 *    screen-layout reconstruction. The caret is then driven with arrow keys,
 *    which pi's Editor applies with its own wrap/scroll/grapheme semantics.
 *  - Drag: button-motion tracking (DECSET 1002) reports drags. The press's
 *    CPR reply provides the row anchor for the whole gesture; motion events
 *    extend the selection; release finalizes it (best-effort clipboard copy).
 *    The selection is rendered by injecting reverse-video into the editor's
 *    own rendered lines, and typing/backspace/delete replaces it.
 *  - Fullscreen: TuiAltScreen consumes all mouse sequences before extension
 *    listeners run, so this extension wraps the alt-screen's viewport input
 *    handler. Left presses in the editor dock and left motion/release during
 *    an editor drag are claimed; transcript selection, scrollbar drags,
 *    OSC 8 links, wheel scrolling, and right-click paste keep native behavior.
 *
 * Trade-offs:
 *  - Regular mode: terminal-native selection needs Shift while mouse
 *    reporting is on (same trade-off pi makes in fullscreen).
 *  - Fullscreen: drags that start inside the editor box select editor text
 *    instead of transcript text (that is the point).
 *  - Word-wrap for row mapping is a close re-implementation of pi's;
 *    CJK-heavy or pasted-marker lines may be off by a row/column.
 *  - If a pi update renames the internal viewport handler, the fullscreen
 *    hook disables itself silently (regular mode keeps working).
 *
 * Debug log: PI_EDITOR_PLUS_DEBUG=1 -> /tmp/pi-editor-plus.log
 *             (legacy alias: PI_MOUSE_CARET_DEBUG)
 */

import * as fs from "node:fs";
import { exec } from "node:child_process";
import * as path from "node:path";
import {
	CustomEditor,
	copyToClipboard,
	getAgentDir,
	getSelectListTheme,
	type ExtensionAPI,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	matchesKey,
	SelectList,
	type SelectItem,
	visibleWidth,
	type Component,
	type TUI,
	type EditorTheme,
} from "@earendil-works/pi-tui";

const VERSION = "1.3.0";
// PI_MOUSE_CARET_DEBUG remains supported as a legacy alias.
const DEBUG =
	process.env.PI_EDITOR_PLUS_DEBUG === "1" || process.env.PI_MOUSE_CARET_DEBUG === "1";
const debug = (message: string) => {
	if (!DEBUG) return;
	try { fs.appendFileSync("/tmp/pi-editor-plus.log", `v${VERSION} ${message}\n`); } catch {}
};

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h"; // press/release + button-motion + SGR
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const CPR_QUERY = "\x1b[6n"; // "report cursor position" -> ESC[row;colR
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const CPR_REPLY = /^\x1b\[(\d+);(\d+)R$/;
const ALT_MOVE_RE = /^(?:\x1b\x1b\[|\x1b\[1;3)([AB])$/; // alt+up / alt+down
const CLICK_BURST_MS = 800; // match/slightly exceed desktop double-click interval
const DRAFT_DEBOUNCE_MS = 2500;
const SEL_START = "\x1b[7m";
const SEL_END = "\x1b[27m";
const SGR_RESET = "\x1b[0m";

interface VisualRow {
	logicalLine: number;
	startCol: number;
	endCol: number;
	text: string;
}

interface Grapheme {
	segment: string;
	index: number;
}

interface Selection {
	line: number; // start (normalized)
	col: number;
	endLine: number;
	endCol: number; // exclusive
}

/** Text history snapshot used by Ctrl+Z undo / Ctrl+Shift+Z redo. */
interface HistoryEntry {
	text: string;
	cursor: { line: number; col: number };
	ts: number;
	/** Marks gestures that must never merge with the previous burst. */
	hardBoundary?: boolean;
}

const GRAPHEME_SEGMENTER =
	typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function segment(text: string): Grapheme[] {
	if (GRAPHEME_SEGMENTER) {
		return [...GRAPHEME_SEGMENTER.segment(text)].map((item) => ({ segment: item.segment, index: item.index }));
	}
	return [...text].map((segment, index) => ({ segment, index }));
}

/** Word-aware wrap mirroring pi-tui's wordWrapLine (startIndex/endIndex kept). */
function wrapLine(line: string, maxWidth: number): Array<{ startCol: number; endCol: number; text: string }> {
	if (!line || maxWidth <= 0 || visibleWidth(line) <= maxWidth) {
		return [{ startCol: 0, endCol: line.length, text: line }];
	}

	const segments = segment(line);
	const chunks: Array<{ startCol: number; endCol: number; text: string }> = [];
	let chunkStart = 0;
	let currentWidth = 0;
	let wrapOpportunity = -1;
	let wrapOpportunityWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const current = segments[i]!;
		const width = visibleWidth(current.segment);

		if (currentWidth + width > maxWidth) {
			if (wrapOpportunity >= 0 && currentWidth - wrapOpportunityWidth + width <= maxWidth) {
				chunks.push({ startCol: chunkStart, endCol: wrapOpportunity, text: line.slice(chunkStart, wrapOpportunity) });
				chunkStart = wrapOpportunity;
				currentWidth -= wrapOpportunityWidth;
			} else if (chunkStart < current.index) {
				chunks.push({ startCol: chunkStart, endCol: current.index, text: line.slice(chunkStart, current.index) });
				chunkStart = current.index;
				currentWidth = 0;
			}
			wrapOpportunity = -1;
		}

		currentWidth += width;
		const next = segments[i + 1];
		if (next && /\s/u.test(current.segment) && !/\s/u.test(next.segment)) {
			wrapOpportunity = next.index;
			wrapOpportunityWidth = currentWidth;
		}
	}

	chunks.push({ startCol: chunkStart, endCol: line.length, text: line.slice(chunkStart) });
	return chunks;
}

/** Full visual-row map using the Editor's own layout width rules. */
function visualRows(lines: string[], terminalWidth: number, paddingX: number): VisualRow[] {
	const layoutWidth = Math.max(1, terminalWidth - (paddingX > 0 ? paddingX * 2 : 1));
	const rows: VisualRow[] = [];
	lines.forEach((text, logicalLine) => {
		for (const chunk of wrapLine(text, layoutWidth)) {
			rows.push({ logicalLine, startCol: chunk.startCol, endCol: chunk.endCol, text: chunk.text });
		}
	});
	return rows;
}

/** Source column for a visual offset within a wrapped row (grapheme-aware). */
function sourceColumnAt(row: VisualRow, offset: number): number {
	if (offset <= 0) return row.startCol;
	let column = 0;
	for (const grapheme of segment(row.text)) {
		const next = column + visibleWidth(grapheme.segment);
		if (offset < next) return row.startCol + grapheme.index;
		column = next;
	}
	return row.endCol;
}

/** Visible offset of a source column within a wrapped row (grapheme-aware). */
function visualOffsetAt(row: VisualRow, col: number): number {
	let column = 0;
	for (const grapheme of segment(row.text)) {
		if (grapheme.index >= col) return column;
		column += visibleWidth(grapheme.segment);
	}
	return column;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\x1b_[^\x07]*\x07/gu, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "");
}

/**
 * Inject selection reverse-video between two visible columns of a rendered
 * line. Walks the string skipping escape sequences (CSI/OSC/APC), re-emitting
 * SEL_START after any SGR reset that occurs inside the selection.
 */
function injectSelection(line: string, fromCol: number, toCol: number): string {
	if (fromCol >= toCol) return line;
	let out = "";
	let column = 0;
	let started = false;
	let closed = false;
	let index = 0;
	while (index < line.length) {
		const char = line[index]!;
		if (char === "\x1b") {
			// Copy the whole escape sequence with zero visible width.
			let end = index + 1;
			const kind = line[end];
			if (kind === "[") {
				end++;
				while (end < line.length && !(line[end]! >= "@" && line[end]! <= "~")) end++;
				end++;
			} else if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
				end++;
				while (end < line.length && line[end] !== "\x07" && !(line[end] === "\x1b" && line[end + 1] === "\\")) end++;
				end = line[end] === "\x1b" ? end + 2 : end + 1;
			} else {
				end++;
			}
			const sequence = line.slice(index, end);
			out += sequence;
			if (started && !closed && sequence === SGR_RESET) out += SEL_START; // keep selection across cursor reset
			index = end;
			continue;
		}
		const width = visibleWidth(char);
		if (width > 0 && !closed) {
			if (!started && column >= fromCol) {
				out += SEL_START;
				started = true;
			} else if (started && column >= toCol) {
				out += SEL_END;
				started = false;
				closed = true; // never re-open past the selection end
			}
			column += width;
		}
		out += char;
		index++;
	}
	if (started) out += SEL_END;
	return out;
}

const DRAFT_FILE = path.join(getAgentDir(), "pi-editor-plus-draft.json");

interface DraftFile {
	text: string;
	cursor: { line: number; col: number };
	savedAt: number;
}

/** History-search overlay component (Ctrl+R). */
class HistoryPicker implements Component {
	private query = "";
	private all: SelectItem[];
	private list: SelectList;
	private onPick: (value: string | undefined) => void;

	constructor(all: string[], onPick: (value: string | undefined) => void) {
		this.onPick = onPick;
		this.all = all.map((text) => ({ value: text, label: text }));
		this.list = this.buildList("");
	}

	private buildList(query: string): SelectList {
		const matches = query ? fuzzyFilter(this.all, query, (item) => item.value) : this.all;
		const list = new SelectList(matches.slice(0, 50), 10, getSelectListTheme());
		list.onSelect = (item) => this.onPick(item.value);
		list.onCancel = () => this.onPick(undefined);
		return list;
	}

	private refilter(): void {
		this.list = this.buildList(this.query);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onPick(undefined);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) {
			this.list.handleInput(data);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.refilter();
			return;
		}
		if (data.length > 0 && data[0] !== "\x1b" && !/[\x00-\x1f\u007f]/u.test(data)) {
			this.query += data;
			this.refilter();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const queryLine = `search: ${this.query}`;
		return [`── search history ──`.padEnd(width, "─"), queryLine, ...this.list.render(width)];
	}
}

/**
 * Registry shared across /reload re-instantiations via globalThis, so a
 * fullscreen hook installed by a previous module instance keeps working.
 */
const ACTIVE_EDITOR_KEY = Symbol.for("pi.editor-plus.activeEditor");

interface Box<T> { current?: T }

function uiHostRef(): Box<ExtensionUIContext> {
	const store = globalThis as Record<symbol, Box<ExtensionUIContext>>;
	if (!store[UI_HOST_KEY]) store[UI_HOST_KEY] = {};
	return store[UI_HOST_KEY]!;
}

function historyProviderRef(): Box<() => string[]> {
	const store = globalThis as Record<symbol, Box<() => string[]>>;
	if (!store[HISTORY_KEY]) store[HISTORY_KEY] = {};
	return store[HISTORY_KEY]!;
}

const UI_HOST_KEY = Symbol.for("pi.editor-plus.uiHost");
const HISTORY_KEY = Symbol.for("pi.editor-plus.historyProvider");

function activeEditorRef(): { current?: MouseCaretEditor } {
	const store = globalThis as Record<symbol, { current?: MouseCaretEditor }>;
	if (!store[ACTIVE_EDITOR_KEY]) store[ACTIVE_EDITOR_KEY] = {};
	return store[ACTIVE_EDITOR_KEY]!;
}

let fullscreenHookInstalled = false;

/**
 * TuiAltScreen consumes all SGR mouse sequences in its viewport input handler
 * before extension input listeners run. Wrap that handler so editor-bound
 * mouse input reaches this extension first; everything else falls through to
 * pi's native selection/scrollbar/link/wheel handling. Detected by feature
 * (method present on the renderer prototype), never by version sniffing.
 */
function installFullscreenHook(tui: TUI): void {
	if (fullscreenHookInstalled) return;
	let proto: object | null = null;
	try {
		proto = Object.getPrototypeOf(tui);
	} catch {
		proto = null;
	}
	if (!proto) return;
	const target = proto as {
		handleViewportInput?: (this: unknown, data: string) => unknown;
		__mouseCaretHook?: boolean;
	};
	if (target.__mouseCaretHook) {
		fullscreenHookInstalled = true; // installed by an earlier module instance
		return;
	}
	if (typeof target.handleViewportInput !== "function") return; // TuiMainScreen: nothing to hook
	const original = target.handleViewportInput;
	const patched = function (this: unknown, data: string): unknown {
		const editor = activeEditorRef().current;
		if (editor && editor.focused && editor.claimsFullscreenMouse(data)) {
			editor.handleMouseSequence(data);
			return { consume: true };
		}
		return original.call(this, data);
	};
	try {
		target.handleViewportInput = patched;
		(target as { __mouseCaretHook: boolean }).__mouseCaretHook = true;
		fullscreenHookInstalled = true;
		debug("fullscreen mouse hook installed");
	} catch {
		// Prototype not writable: fullscreen support unavailable, regular mode unaffected.
	}
}

class MouseCaretEditor extends CustomEditor {
	private lastRenderedLines: string[] = [];
	private mouseReported = false;
	private pendingClick: { x: number; y: number; multiClick?: number } | undefined; // 1-based terminal coords
	private boundsCache: { top: number; bottom: number } | undefined; // content rows, 1-based
	private dragAnchorRow: number | undefined; // 1-based screen row of visual row 0, cached at press
	private dragging = false;
	private dragAnchor: { line: number; col: number } | undefined;
	private selection: Selection | undefined;
	private caretUndoStack: HistoryEntry[] = []; // pre-edit anchors, oldest first
	private caretRedoStack: HistoryEntry[] = [];
	private lastEditAt = 0;
	private lastEditWasTyping = false;
	/** Footer-status toast hook, assigned by the extension factory per session. */
	uiToast?: (message: string) => void;
	/** Multi-click tracking for double/triple click word/line selection. */
	private lastClickTrack: { ts: number; x: number; y: number; count: number } | undefined;
	private draftTimer: ReturnType<typeof setTimeout> | undefined;
	private rowsCache: VisualRow[] = [];
	private rowsCacheText = "";
	private rowsCacheWidth = -1;
	private rowsCachePadding = -1;
	private undoBytes = 0;
	private redoBytes = 0;
	private readonly tuiRef: TUI;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.tuiRef = tui;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		this.lastRenderedLines = lines;
		installFullscreenHook(this.tuiRef);
		if (!this.mouseReported && this.tuiRef.mode === "regular") {
			this.tuiRef.terminal.write(ENABLE_MOUSE);
			this.mouseReported = true;
			debug("mouse reporting enabled");
		}
		return this.applySelectionRendering(lines);
	}

	/** Highlight the active selection by injecting reverse-video into rendered content lines. */
	private applySelectionRendering(lines: string[]): string[] {
		const selection = this.selection;
		if (!selection) return lines;
		const logicalLines = this.getLines();
		if (selection.endLine >= logicalLines.length) {
			this.selection = undefined; // text shrank (e.g. submitted): drop stale selection
			return lines;
		}

		const rows = this.getVisualRows();
		const paddingX = this.getPaddingX();
		const scrollOffset = Number(stripAnsi(lines[0] ?? "").match(/↑\s+(\d+)\s+more/u)?.[1] ?? 0);

		// Content lines sit between the top border (index 0) and the bottom
		// border. The bottom border is the last ─-dominated line; autocomplete
		// rows render below it but contain few dashes.
		const isBorder = (line: string): boolean => {
			const clean = stripAnsi(line);
			const dashes = (clean.match(/─/gu) ?? []).length;
			return dashes >= 3 && dashes >= Math.floor(clean.replace(/\s/gu, "").length * 0.8);
		};
		let bottomBorder = lines.length - 1;
		for (let index = lines.length - 1; index >= 1; index--) {
			if (isBorder(lines[index]!)) {
				bottomBorder = index;
				break;
			}
		}

		for (let index = 1; index < bottomBorder; index++) {
			const row = rows[scrollOffset + index - 1];
			if (!row || row.logicalLine < selection.line || row.logicalLine > selection.endLine) {
				debug(`selrow ${index}: skip (row=${row ? `${row.logicalLine}:${row.startCol}-${row.endCol}` : "none"} sel=${JSON.stringify(selection)})`);
				continue;
			}
			const startCol = row.logicalLine === selection.line ? Math.max(selection.col, row.startCol) : row.startCol;
			const endCol = row.logicalLine === selection.endLine ? Math.min(selection.endCol, row.endCol) : row.endCol;
			if (startCol >= endCol) {
				debug(`selrow ${index}: empty range ${startCol}..${endCol}`);
				continue;
			}
			// startCol/endCol are logical-line source columns; the chunk only spans
			// [row.startCol, row.endCol] — convert to chunk-relative first, or the
			// visible-offset walk overflows continuation chunks and paints nothing.
			const fromCol = paddingX + visualOffsetAt(row, Math.max(0, startCol - row.startCol));
			const toCol = paddingX + visualOffsetAt(row, Math.max(0, Math.min(endCol, row.endCol) - row.startCol));
			debug(`selrow ${index}: line=${row.logicalLine} src=${startCol}..${endCol} vis=${fromCol}..${toCol} rowtext=${JSON.stringify(row.text.slice(0, 30))}`);
			lines[index] = injectSelection(lines[index]!, fromCol, toCol);
		}
		return lines;
	}

	shutdownMouse(): void {
		if (!this.mouseReported) return;
		this.tuiRef.terminal.write(DISABLE_MOUSE);
		this.mouseReported = false;
	}

	private selectionRange(): Selection | undefined {
		const selection = this.selection;
		if (!selection) return undefined;
		if (selection.line === selection.endLine && selection.col === selection.endCol) return undefined;
		return selection;
	}

	private clearSelection(): void {
		if (!this.selection) return;
		this.selection = undefined;
		this.tuiRef.requestRender();
	}

	/** Handle an SGR mouse sequence. Returns true when consumed. */
	handleMouseSequence(data: string): boolean {
		const match = SGR_MOUSE.exec(data);
		if (!match) return false;

		const button = Number.parseInt(match[1]!, 10);
		const x = Number.parseInt(match[2]!, 10);
		const y = Number.parseInt(match[3]!, 10);
		const release = match[4] === "m";
		const isLeft = (button & 3) === 0;
		const isMotion = (button & 32) !== 0;
		const isWheel = (button & 64) !== 0;

		if (isMotion) {
			if (this.dragging && isLeft && this.dragAnchorRow !== undefined) {
				this.extendSelection(x, y);
				return true;
			}
			return true; // motion without our drag: swallow (regular mode) / not claimed (fullscreen)
		}
		if (release) {
			if (this.dragging) this.finishDrag();
			return true;
		}
		// Middle button (mouse middle-click / three-finger tap): paste primary selection.
		const isMiddle = (button & 3) === 1;
		if (isMiddle) {
			const caretAtClick = { ...this.getCursor() };
			debug(`middle-click at ${x},${y} -> async primary read`);
			void this.readPrimarySelection().then((text) => {
				if (!text || !this.focused || activeEditorRef().current !== this) return;
				debug(`middle-click primary=${JSON.stringify(text.slice(0, 80))}`);
				this.setCaret(caretAtClick.line, caretAtClick.col);
				if (this.selectionRange()) this.deleteSelection();
				this.insertTextAtCursor(text);
				this.uiToast?.(`✓ pasted ${text.length} character${text.length === 1 ? "" : "s"}`);
				this.tuiRef.requestRender();
			});
			return true;
		}
		if (isWheel || !isLeft) return true; // not ours: swallow in regular, unclaimed in fullscreen

		if (this.isShowingAutocomplete()) {
			debug("click ignored: autocomplete open");
			return true;
		}

		// Multi-click detection: double = word select, triple = line select.
		const nowMs = Date.now();
		const prev = this.lastClickTrack;
		const count =
			prev && nowMs - prev.ts <= CLICK_BURST_MS && Math.abs(prev.x - x) <= 2 && Math.abs(prev.y - y) <= 2
				? (prev.count % 3) + 1
				: 1;
		this.lastClickTrack = { ts: nowMs, x, y, count };
		this.clearSelection();
		this.pendingClick = { x, y, multiClick: count >= 2 ? count : undefined };
		this.tuiRef.terminal.write(CPR_QUERY);
		debug(`click x=${x} y=${y} multiClick=${count >= 2} -> CPR sent`);
		return true;
	}

	/** Handle a CPR reply (ESC[row;colR). Returns true when consumed. */
	handleCursorReport(data: string): boolean {
		const match = CPR_REPLY.exec(data);
		if (!match) return false;

		const caretRow = Number.parseInt(match[1]!, 10); // 1-based screen row of caret
		const click = this.pendingClick;
		this.pendingClick = undefined;
		if (!click) return true; // stray report: swallow so it never reaches components
		if (click.multiClick) {
			this.applyMultiClick(click, caretRow);
		} else {
			this.applyClick(click, caretRow);
		}
		return true;
	}

	private applyClick(click: { x: number; y: number }, caretRow: number): void {
		const rows = this.getVisualRows();
		if (rows.length === 0) return;

		const current = this.getCursor();
		let currentIndex = rows.findIndex(
			(row) => row.logicalLine === current.line && current.col >= row.startCol && current.col <= row.endCol,
		);
		if (currentIndex < 0) {
			currentIndex = rows.findIndex((row) => row.logicalLine === current.line);
		}
		if (currentIndex < 0) currentIndex = 0;

		// Rows hidden above the current scroll window ("─── ↑ N more ───").
		const scrollOffset = Number(stripAnsi(this.lastRenderedLines[0] ?? "").match(/↑\s+(\d+)\s+more/u)?.[1] ?? 0);

		// 1-based screen row of visual row 0 (derived from the caret's own row).
		const anchor = caretRow - currentIndex;
		const firstVisibleRow = anchor + scrollOffset;
		const lastRow = anchor + rows.length - 1;
		// The anchor is valid regardless of where this click landed: cache it so
		// press-time routing and drag motion use the editor box position.
		this.boundsCache = { top: firstVisibleRow, bottom: lastRow };
		this.dragAnchorRow = anchor;

		// Accept the whole editor box: content rows plus one border row each side.
		if (click.y < firstVisibleRow - 1 || click.y > lastRow + 1) {
			debug(`click outside editor: y=${click.y} bounds=[${firstVisibleRow - 1},${lastRow + 1}]`);
			return;
		}

		const targetIndex = Math.min(rows.length - 1, Math.max(click.y - anchor, 0));
		const targetRow = rows[targetIndex]!;

		// Direct caret placement (no synchronous arrow replay — O(1) even for huge docs).
		const visualOffset = Math.max(0, Math.min(click.x - 1 - this.getPaddingX(), visibleWidth(targetRow.text)));
		const targetCol = sourceColumnAt(targetRow, visualOffset);
		this.setCaret(targetRow.logicalLine, targetCol);

		// A press starts a potential drag: anchor the selection at the caret.
		this.dragging = true;
		this.dragAnchor = { line: targetRow.logicalLine, col: this.getCursor().col };
		this.selection = {
			line: this.dragAnchor.line,
			col: this.dragAnchor.col,
			endLine: this.dragAnchor.line,
			endCol: this.dragAnchor.col,
		};

		debug(
			`click (${click.x},${click.y}) caretRow=${caretRow} anchor=${anchor} scroll=${scrollOffset} ` +
			`cursor=${JSON.stringify(this.getCursor())}`,
		);
		this.tuiRef.requestRender();
	}

	private extendSelection(x: number, y: number): void {
		const rows = this.getVisualRows();
		if (rows.length === 0 || this.dragAnchorRow === undefined || !this.dragAnchor) return;
		const index = Math.min(rows.length - 1, Math.max(y - this.dragAnchorRow, 0));
		const row = rows[index]!;
		const offset = Math.max(0, Math.min(x - 1 - this.getPaddingX(), visibleWidth(row.text)));
		const col = sourceColumnAt(row, offset);
		const anchor = this.dragAnchor;
		this.selection =
			anchor.line < row.logicalLine || (anchor.line === row.logicalLine && anchor.col <= col)
				? { line: anchor.line, col: anchor.col, endLine: row.logicalLine, endCol: col }
				: { line: row.logicalLine, col, endLine: anchor.line, endCol: anchor.col };
		this.tuiRef.requestRender();
	}

	private finishDrag(): void {
		this.dragging = false;
		this.dragAnchor = undefined;
		const selection = this.selectionRange();
		if (!selection) return;
		debug(`selection ${JSON.stringify(selection)}`);
		// Terminal-style: selecting copies to the clipboard (best effort).
		const lines = this.getLines();
		const text =
			selection.line === selection.endLine
				? (lines[selection.line] ?? "").slice(selection.col, selection.endCol)
				: [
						(lines[selection.line] ?? "").slice(selection.col),
						...lines.slice(selection.line + 1, selection.endLine),
						(lines[selection.endLine] ?? "").slice(0, selection.endCol),
					].join("\n");
		this.uiToast?.(`✓ copied ${text.length} character${text.length === 1 ? "" : "s"}`);
		void copyToClipboard(text).catch(() => {});
	}

	/** Delete the active selection, placing the caret at its start. */
	private deleteSelection(): void {
		const selection = this.selectionRange();
		if (!selection) return;
		const lines = this.getLines();
		const rebuilt =
			selection.line === selection.endLine
				? lines.map((line, index) =>
						index === selection.line ? line.slice(0, selection.col) + line.slice(selection.endCol) : line,
					)
				: [
						...lines.slice(0, selection.line),
						(lines[selection.line] ?? "").slice(0, selection.col) +
							(lines[selection.endLine] ?? "").slice(selection.endCol),
						...lines.slice(selection.endLine + 1),
					];
		this.selection = undefined;
		this.setText(rebuilt.join("\n"));
		// setText leaves the caret at the end; place it directly at the selection start.
		this.moveCaretTo({ line: selection.line, col: selection.col });
	}

	/** Replace-on-type and clear-on-move for the active selection, plus undo/redo keys. */
	handleInput(data: string): void {
		if (DEBUG) {
			if (!/[\x20-\x7e]/u.test(data)) {
				const traced = [...data].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
				debug(`handleInput bytes=[${traced}]`);
			} else {
				debug(`handleInput ${JSON.stringify(data)}`);
			}
		}
		if (matchesKey(data, "ctrl+z")) {
			debug("ctrl+z detected -> undoOnce");
			this.undoOnce();
			return;
		}
		// Redo: prefer Ctrl+Shift+Z where the terminal can distinguish it
		// (Kitty protocol / modifyOtherKeys). Plain-legacy terminals collapse
		// it into the same byte as Ctrl+Z, so Ctrl+Y (VS Code convention) is
		// the universal fallback. Trade-off: shadows kill-ring yank.
		if (matchesKey(data, "ctrl+shift+z") || matchesKey(data, "ctrl+y")) {
			this.redoOnce();
			return;
		}
		if (!this.isShowingAutocomplete()) {
			if (matchesKey(data, "ctrl+r")) {
				this.openHistorySearch();
				return;
			}
			if (matchesKey(data, "ctrl+a")) {
				this.selectAll();
				return;
			}
			const altMove = ALT_MOVE_RE.exec(data);
			if (altMove) {
				this.moveLine(altMove[1] === "A" ? -1 : 1);
				return;
			}
			// Ctrl+D duplicates the current line (only when there is text;
			// on an empty editor Ctrl+D keeps its native exit behavior).
			if (matchesKey(data, "ctrl+d") && this.getText().length > 0) {
				this.duplicateLine();
				return;
			}
		}
		const before = this.snapshot();
		const selection = this.selectionRange();
		if (selection) {
			const printable = data.length > 0 && data[0] !== "\x1b" && !/[\x00-\x1f\u007f]/u.test(data);
			const isBackspace = matchesKey(data, "backspace");
			const isDelete = matchesKey(data, "delete");
			const isEnter = matchesKey(data, "enter") || matchesKey(data, "shift+enter") || data === "\x1b\r" || data === "\n";
			const isPaste = data.includes("\x1b[200~");
			if (isEnter) {
				this.deleteSelection(); // GUI convention: Enter replaces selection with newline
			} else if (isPaste) {
				this.deleteSelection(); // paste replaces selection
			} else if (printable || isBackspace || isDelete) {
				this.deleteSelection();
				if (isBackspace || isDelete) return; // the deletion was the edit
			} else if (
				matchesKey(data, "up") || matchesKey(data, "down") ||
				matchesKey(data, "left") || matchesKey(data, "right") ||
				matchesKey(data, "home") || matchesKey(data, "end") ||
				matchesKey(data, "pageUp") || matchesKey(data, "pageDown")
			) {
				this.clearSelection();
			}
		}
		super.handleInput(data);
		this.recordEdit(before, data);
	}

	// =========================================================================
	// Undo / redo history (Ctrl+Z / Ctrl+Shift+Z)
	// =========================================================================

	private static readonly BURST_MS = 450;
	private static readonly MAX_HISTORY = 300;
	/** Hard cap on retained undo/redo text (approximation of UTF-16 units). */
	private static readonly MAX_UNDO_BYTES = 16 * 1024 * 1024;

	private pushUndo(entry: HistoryEntry): void {
		this.caretUndoStack.push(entry);
		this.undoBytes += entry.text.length;
		while (
			this.caretUndoStack.length > MouseCaretEditor.MAX_HISTORY ||
			this.undoBytes > MouseCaretEditor.MAX_UNDO_BYTES
		) {
			const old = this.caretUndoStack.shift();
			if (!old) break;
			this.undoBytes -= old.text.length;
		}
	}

	private popUndo(): HistoryEntry | undefined {
		const entry = this.caretUndoStack.pop();
		if (entry) this.undoBytes -= entry.text.length;
		return entry;
	}

	private pushRedo(entry: HistoryEntry): void {
		this.caretRedoStack.push(entry);
		this.redoBytes += entry.text.length;
		while (
			this.caretRedoStack.length > MouseCaretEditor.MAX_HISTORY ||
			this.redoBytes > MouseCaretEditor.MAX_UNDO_BYTES
		) {
			const old = this.caretRedoStack.shift();
			if (!old) break;
			this.redoBytes -= old.text.length;
		}
	}

	private popRedo(): HistoryEntry | undefined {
		const entry = this.caretRedoStack.pop();
		if (entry) this.redoBytes -= entry.text.length;
		return entry;
	}

	private clearRedo(): void {
		this.caretRedoStack = [];
		this.redoBytes = 0;
	}

	private snapshot(): HistoryEntry {
		return { text: this.getText(), cursor: { ...this.getCursor() }, ts: Date.now() };
	}

	/** Capture the pre-edit state if the keypress actually changed the text. */
	private recordEdit(before: HistoryEntry, data: string): void {
		const after = this.getText();
		if (after === before.text) return;

		const now = Date.now();
		const isTyping = data.length > 0 && data[0] !== "\x1b" && !/[\x00-\x1f\u007f]/u.test(data);
		const isStructural = data.includes("\x1b[200~") || data === "\r" || data === "\n" || matchesKey(data, "enter");
		const mergesWithPrevious =
			isTyping && this.lastEditWasTyping && now - this.lastEditAt <= MouseCaretEditor.BURST_MS;

		// A new burst always records the state BEFORE its first keystroke.
		if (!mergesWithPrevious) {
			this.pushUndo({ ...before, ts: now, hardBoundary: isStructural });
			this.clearRedo();
		}
		this.lastEditAt = now;
		this.lastEditWasTyping = isTyping;
		if (after.length === 0) this.clearDraftFile();
		else this.scheduleDraftSave();
	}

	private applyHistory(entry: HistoryEntry): void {
		this.selection = undefined;
		this.setText(entry.text); // single-step for pi's own ctrl+- undo too
		this.moveCaretTo(entry.cursor);
		this.tuiRef.requestRender();
	}

	undoOnce(): boolean {
		while (this.caretUndoStack.length > 0) {
			const candidate = this.popUndo()!;
			if (candidate.text === this.getText()) continue; // skip no-op anchors
			this.pushRedo(this.snapshot());
			this.applyHistory(candidate);
			debug(`undo -> ${JSON.stringify(candidate.cursor)} text=${candidate.text.length} chars`);
			return true;
		}
		debug("undo: nothing to undo");
		return false;
	}

	redoOnce(): boolean {
		const next = this.popRedo();
		if (!next) {
			debug("redo: nothing to redo");
			return false;
		}
		this.pushUndo({ ...this.snapshot(), ts: Date.now() });
		this.applyHistory(next);
		debug(`redo -> ${JSON.stringify(next.cursor)} text=${next.text.length} chars`);
		return true;
	}

	// =========================================================================
	// Selection via keyboard / multi-click, line ops, history, draft
	// =========================================================================

	/** Place the caret directly (no synchronous arrow replay — O(1) even for huge docs). */
	private setCaret(line: number, col: number): void {
		const state = (this as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number; preferredVisualCol: number | null; snappedFromCursorCol: number | null } }).state;
		state.cursorLine = Math.max(0, Math.min(line, state.lines.length - 1));
		state.cursorCol = Math.max(0, Math.min(col, (state.lines[state.cursorLine] ?? "").length));
		state.preferredVisualCol = null;
		state.snappedFromCursorCol = null;
	}

	/** Cached visual-row map: recomputed only when text/width/padding changes. */
	private getVisualRows(): VisualRow[] {
		const text = this.getText();
		const width = this.tuiRef.terminal.columns;
		const paddingX = this.getPaddingX();
		if (this.rowsCacheText !== text || this.rowsCacheWidth !== width || this.rowsCachePadding !== paddingX) {
			this.rowsCache = visualRows(this.getLines(), width, paddingX);
			this.rowsCacheText = text;
			this.rowsCacheWidth = width;
			this.rowsCachePadding = paddingX;
		}
		return this.rowsCache;
	}

	/** Walk the caret to an absolute logical position (direct placement). */
	private moveCaretTo(target: { line: number; col: number }): void {
		this.setCaret(target.line, target.col);
	}

	private setSelectionNormalized(a: { line: number; col: number }, b: { line: number; col: number }): void {
		this.selection =
			a.line < b.line || (a.line === b.line && a.col <= b.col)
				? { line: a.line, col: a.col, endLine: b.line, endCol: b.col }
				: { line: b.line, col: b.col, endLine: a.line, endCol: a.col };
		this.tuiRef.requestRender();
	}

	private selectAll(): void {
		const lines = this.getLines();
		const lastLine = lines.length - 1;
		this.selection = { line: 0, col: 0, endLine: lastLine, endCol: (lines[lastLine] ?? "").length };
		this.moveCaretTo({ line: lastLine, col: (lines[lastLine] ?? "").length });
		this.tuiRef.requestRender();
	}

	/** Double-click selects the word under the pointer; triple-click the whole line. */
	private applyMultiClick(click: { x: number; y: number; multiClick?: number }, caretRow: number): void {
		const count = click.multiClick!;
		// The first press already moved the caret to the clicked cell, and pi keeps
		// the caret correct at any terminal width. Use the CARET (not a re-mapped
		// screen X) as the anchor for the word/line — robust across widths/wrapping.
		const caret = this.getCursor();
		const logical = this.getLines()[caret.line] ?? "";
		let span: { s: number; e: number };
		if (count >= 3) {
			span = { s: 0, e: logical.length };
		} else {
			const at = Math.min(caret.col, Math.max(0, logical.length - 1));
			const isWord = (ch: string) => /[\w@/.\-~]/u.test(ch);
			const isSpace = (ch: string) => /\s/u.test(ch);
			const cls = logical.length ? (isWord(logical[at]!) ? "w" : isSpace(logical[at]!) ? "s" : "p") : "s";
			const same = (ch: string) => (cls === "w" ? isWord(ch) : cls === "s" ? isSpace(ch) : !isWord(ch) && !isSpace(ch));
			let st = at;
			while (st > 0 && logical[st - 1] !== undefined && same(logical[st - 1]!)) st--;
			let en = at;
			while (en < logical.length && logical[en] !== undefined && same(logical[en]!)) en++;
			span = { s: st, e: Math.max(en, st + 1) };
		}

		this.selection = { line: caret.line, col: span.s, endLine: caret.line, endCol: span.e };
		this.moveCaretTo({ line: caret.line, col: span.e });
		if (span.e > span.s) {
			this.uiToast?.(`✓ copied ${span.e - span.s} character${span.e - span.s === 1 ? "" : "s"}`);
			void copyToClipboard(logical.slice(span.s, span.e)).catch(() => {});
		}
		this.tuiRef.requestRender();
	}

	/** Alt+Up/Down: swap the current logical line with its neighbor. */
	private moveLine(dir: -1 | 1): void {
		this.clearSelection();
		const state = (this as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number; preferredVisualCol: number | null; snappedFromCursorCol: number | null } }).state;
		const before = this.snapshot();
		const l = state.cursorLine;
		const t = l + dir;
		if (t < 0 || t >= state.lines.length) return;
		const tmp = state.lines[l]!;
		state.lines[l] = state.lines[t]!;
		state.lines[t] = tmp;
		state.cursorLine = t;
		state.cursorCol = Math.min(state.cursorCol, state.lines[t]!.length);
		state.preferredVisualCol = null;
		this.afterDirectEdit(before);
	}

	/** Ctrl+D: duplicate the current logical line below, caret moves to the copy. */
	private duplicateLine(): void {
		this.clearSelection();
		const state = (this as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number; preferredVisualCol: number | null; snappedFromCursorCol: number | null } }).state;
		const before = this.snapshot();
		const l = state.cursorLine;
		state.lines.splice(l + 1, 0, state.lines[l]!);
		state.cursorLine = l + 1;
		this.afterDirectEdit(before);
	}

	/** Shared tail for direct state edits: undo anchor, change notify, redraw. */
	private afterDirectEdit(before: { text: string; cursor: { line: number; col: number } }): void {
		this.pushUndo({ ...before, ts: Date.now(), hardBoundary: true });
		this.clearRedo();
		this.lastEditAt = Date.now();
		this.lastEditWasTyping = false;
		this.onChange?.(this.getText());
		this.tuiRef.requestRender();
	}

	// =========================================================================
	// Draft persistence (crash / accidental-clear recovery)
	// =========================================================================

	/** Read the X11/Wayland primary selection (middle-click source), async. Text only. */
	private readPrimarySelection(): Promise<string | undefined> {
		const tryCmd = (cmd: string): Promise<string | undefined> =>
			new Promise((resolve) => {
				exec(cmd, { timeout: 600, encoding: "utf8" }, (error, stdout) => {
					if (error || stdout.includes("\0")) resolve(undefined);
					else resolve(stdout);
				});
			});
		// Wayland first, then X11.
		return (async () => (await tryCmd("wl-paste --primary --no-newline")) ?? (await tryCmd("xclip -o -selection primary")))();
	}

	private scheduleDraftSave(): void {
		if (this.draftTimer) clearTimeout(this.draftTimer);
		this.draftTimer = setTimeout(() => this.writeDraftNow(), DRAFT_DEBOUNCE_MS);
	}

	private writeDraftNow(): void {
		try {
			const text = this.getText();
			if (text.length === 0) {
				fs.rmSync(DRAFT_FILE, { force: true });
				return;
			}
			const draft: DraftFile = { text, cursor: { ...this.getCursor() }, savedAt: Date.now() };
			fs.writeFileSync(DRAFT_FILE, JSON.stringify(draft));
		} catch {}
	}

	flushDraft(): void {
		if (this.draftTimer) clearTimeout(this.draftTimer);
		this.writeDraftNow();
	}

	/** Restore a previous draft into an empty editor. Returns true when restored. */
	restoreDraftIfAny(): boolean {
		try {
			if (this.getText().length > 0) return false;
			const raw = fs.readFileSync(DRAFT_FILE, "utf8");
			const draft = JSON.parse(raw) as DraftFile;
			if (!draft.text) return false;
			this.setText(draft.text);
			this.moveCaretTo(draft.cursor);
			this.tuiRef.requestRender();
			return true;
		} catch {
			return false;
		}
	}

	private clearDraftFile(): void {
		if (this.draftTimer) clearTimeout(this.draftTimer);
		try { fs.rmSync(DRAFT_FILE, { force: true }); } catch {}
	}

	/** Ctrl+R: fuzzy-searchable overlay over past user prompts. */
	private openHistorySearch(): void {
		const ui = uiHostRef().current;
		const provider = historyProviderRef().current;
		if (!ui || !provider) return;
		const items = provider();
		debug(`ctrl+r history items=${items.length} first=${JSON.stringify(items[0] ?? null)}`);
		if (items.length === 0) {
			this.uiToast?.("no prompt history yet");
			return;
		}
		void ui
			.custom<string | undefined>((tui, theme, keybindings, done) => new HistoryPicker(items, (value) => done(value)))
			.then((picked) => {
				if (!picked) return;
				const before = this.snapshot();
				this.selection = undefined;
				this.setText(picked);
				this.pushUndo({ ...before, ts: Date.now(), hardBoundary: true });
				this.clearRedo();
				this.moveCaretTo({ line: this.getLines().length - 1, col: (this.getLines()[this.getLines().length - 1] ?? "").length });
				this.tuiRef.requestRender();
			})
			.catch(() => {});
	}

	/**
	 * Fullscreen routing (called from the wrapped viewport handler): claim left
	 * presses that land in the editor box, plus left motion/release while an
	 * editor drag is active. Uses the CPR-derived bounds cache; before the
	 * first CPR reply, optimistically claims the bottom dock area.
	 */
	claimsFullscreenMouse(data: string): boolean {
		if (this.tuiRef.mode !== "fullscreen") return false;
		const match = SGR_MOUSE.exec(data);
		if (!match) return false;
		const button = Number.parseInt(match[1]!, 10);
		const isLeft = (button & 3) === 0;
		if (!isLeft) return false;
		const release = match[4] === "m";
		const isMotion = (button & 32) !== 0;
		if (this.dragging && (isMotion || release)) return true; // whole gesture is ours
		if (release || isMotion || (button & 64) !== 0) return false;
		const y = Number.parseInt(match[3]!, 10);
		if (this.boundsCache) {
			return y >= this.boundsCache.top - 1 && y <= this.boundsCache.bottom + 1;
		}
		const height = this.tuiRef.terminal.rows;
		return y >= height - this.lastRenderedLines.length - 4 && y <= height;
	}
}

/**
 * Forward compatibility: if upstream pi ever grows a native mouse/cursor
 * editing API (issue #4928), defer to it instead of fighting over input.
 */
function upstreamMouseApiDetected(): boolean {
	let proto: object | null = CustomEditor.prototype;
	while (proto) {
		const methods = proto as Record<string, unknown>;
		if (typeof methods.setCursor === "function") return true;
		if (typeof methods.handleMouseEvent === "function") return true;
		if (typeof methods.handleMouse === "function") return true;
		proto = Object.getPrototypeOf(proto);
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		debug("extension session_start");

		uiHostRef().current = ctx.ui;
		historyProviderRef().current = () => {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message" || entry.message.role !== "user") continue;
				const parts = entry.message.content;
				const text = (typeof parts === "string"
					? parts
					: parts.map((part) => (part.type === "text" ? part.text : "")).join("")).trim();
				if (!text || seen.has(text)) continue;
				seen.add(text);
				out.unshift(text); // oldest first -> newest last
				if (out.length > 300) break;
			}
			return out;
		};

		let toastTimer: ReturnType<typeof setTimeout> | undefined;
		const showToast = (message: string) => {
			try {
				ctx.ui.setStatus("pi-editor-plus", message);
				if (toastTimer) clearTimeout(toastTimer);
				toastTimer = setTimeout(() => {
					try { ctx.ui.setStatus("pi-editor-plus", undefined); } catch {}
				}, 2000);
			} catch {}
		};

		if (upstreamMouseApiDetected()) {
			debug("native editor mouse API detected - staying passive");
			try { ctx.ui.notify("pi-editor-plus: pi now has native mouse support, extension disabled", "info"); } catch {}
			return;
		}

		let editor: MouseCaretEditor | undefined;
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			editor = new MouseCaretEditor(tui, theme, keybindings);
			editor.uiToast = showToast;
			activeEditorRef().current = editor;
			// Restore the draft AFTER interactive-mode's bind sequence finishes —
			// it calls setText(currentText) (empty) right after the factory, which
			// would wipe a synchronous restore.
			setTimeout(() => {
				if (!editor) return;
				if (editor.restoreDraftIfAny()) showToast("draft recovered — ctrl+z dismisses");
			}, 0);
			return editor;
		});

		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (SGR_MOUSE.test(data)) {
				if (!editor || !editor.focused) return undefined;
				return editor.handleMouseSequence(data) ? { consume: true } : undefined;
			}
			if (CPR_REPLY.test(data)) {
				if (!editor) return undefined;
				return editor.handleCursorReport(data) ? { consume: true } : undefined;
			}
			return undefined;
		});

		pi.on("session_shutdown", () => {
			unsubscribe();
			editor?.flushDraft();
			editor?.shutdownMouse();
		});
	});
}
