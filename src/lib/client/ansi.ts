/**
 * Tiny ANSI → HTML converter used by the dashboard thumbnail snapshots.
 *
 * We can't reuse an xterm.js instance for every card — that's what the
 * terminal modal is for — but we still want the snapshot to show the
 * same colors the user would see if they opened the pane. So we parse
 * the SGR subset of ANSI escapes emitted by `tmux capture-pane -e`
 * ourselves and wrap text runs in <span style="…"> elements.
 *
 * Supported:
 *   - CSI SGR reset (0) and attributes 1/2/3/4 (bold/dim/italic/underline)
 *     plus 22/23/24 to turn them off.
 *   - Standard 16 foreground (30–37, 90–97) and background (40–47, 100–107) colors.
 *   - 256-color palettes via ESC[38;5;Nm and ESC[48;5;Nm.
 *   - 24-bit truecolor via ESC[38;2;R;G;Bm and ESC[48;2;R;G;Bm.
 *
 * Non-SGR CSI sequences (cursor moves, erase line, etc.) are stripped —
 * tmux captures are a rendered snapshot of the screen, not a replay
 * log, so there's nothing to do with them.
 *
 * Text is HTML-escaped, so embedded `<`, `>`, `&` in tmux output can't
 * break out of the pre. Colors are emitted as closed-form `rgb(…)` /
 * `#xxxxxx` values, so the inline style attribute never contains an
 * attacker-controlled substring.
 */

// Tango-inspired 16-color palette. Matches what most terminals render
// for the 30–37 / 90–97 foreground (and 40–47 / 100–107 background)
// codes. We pick a palette rather than deferring to the browser because
// the snapshot pre has a near-black background and we want the same
// look across browsers.
const BASE = [
  '#000000',
  '#cc0000',
  '#4e9a06',
  '#c4a000',
  '#3465a4',
  '#75507b',
  '#06989a',
  '#d3d7cf'
];
const BRIGHT = [
  '#555753',
  '#ef2929',
  '#8ae234',
  '#fce94f',
  '#729fcf',
  '#ad7fa8',
  '#34e2e2',
  '#eeeeec'
];

/** Map an xterm 256-color index to an `rgb(...)` string. */
function xterm256(n: number): string {
  if (n < 8) return BASE[n] ?? '#000000';
  if (n < 16) return BRIGHT[n - 8] ?? '#ffffff';
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const scale = (c: number): number => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${scale(r)},${scale(g)},${scale(b)})`;
}

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

interface State {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function freshState(): State {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

function applyParams(state: State, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === undefined) continue;
    if (p === 0 || Number.isNaN(p)) {
      Object.assign(state, freshState());
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 22) {
      state.bold = false;
      state.dim = false;
    } else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p >= 30 && p <= 37) state.fg = BASE[p - 30] ?? null;
    else if (p === 38) {
      const mode = params[i + 1];
      if (mode === 5) {
        const idx = params[i + 2];
        if (idx !== undefined) {
          state.fg = xterm256(idx);
          i += 2;
        }
      } else if (mode === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          state.fg = `rgb(${r},${g},${b})`;
          i += 4;
        }
      }
    } else if (p === 39) state.fg = null;
    else if (p >= 40 && p <= 47) state.bg = BASE[p - 40] ?? null;
    else if (p === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        const idx = params[i + 2];
        if (idx !== undefined) {
          state.bg = xterm256(idx);
          i += 2;
        }
      } else if (mode === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          state.bg = `rgb(${r},${g},${b})`;
          i += 4;
        }
      }
    } else if (p === 49) state.bg = null;
    else if (p >= 90 && p <= 97) state.fg = BRIGHT[p - 90] ?? null;
    else if (p >= 100 && p <= 107) state.bg = BRIGHT[p - 100] ?? null;
  }
}

function styleString(state: State): string {
  const parts: string[] = [];
  if (state.fg) parts.push(`color:${state.fg}`);
  if (state.bg) parts.push(`background:${state.bg}`);
  if (state.bold) parts.push('font-weight:bold');
  if (state.dim) parts.push('opacity:0.6');
  if (state.italic) parts.push('font-style:italic');
  if (state.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

/**
 * Strip ANSI/VT100 CSI sequences from `text`, leaving only the printable
 * glyphs. Used to measure the content box for the thumbnail card.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[?0-9;]*[A-Za-ln-~]/g, '');
}

/**
 * Convert `text` (which may contain SGR escape sequences) into HTML. The
 * returned string is safe to insert with `{@html}` into a `<pre>` — the
 * text content is HTML-escaped and the emitted span styles are limited
 * to a closed set of color / weight / decoration rules.
 */
export function ansiToHtml(text: string): string {
  // Drop non-SGR CSI sequences (anything ending in a char other than 'm').
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/\x1b\[[?0-9;]*([A-Za-ln-~])/g, (m, final) =>
    final === 'm' ? m : ''
  );

  const state = freshState();
  let out = '';
  let openSpan = false;
  let cursor = 0;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleaned)) !== null) {
    if (match.index > cursor) {
      out += esc(cleaned.slice(cursor, match.index));
    }
    if (openSpan) {
      out += '</span>';
      openSpan = false;
    }
    const raw = match[1] ?? '';
    const params =
      raw.length === 0
        ? [0]
        : raw
            .split(';')
            .filter((s) => s.length > 0)
            .map((s) => parseInt(s, 10));
    applyParams(state, params);
    const style = styleString(state);
    if (style) {
      out += `<span style="${style}">`;
      openSpan = true;
    }
    cursor = re.lastIndex;
  }
  if (cursor < cleaned.length) {
    out += esc(cleaned.slice(cursor));
  }
  if (openSpan) out += '</span>';
  return out;
}
