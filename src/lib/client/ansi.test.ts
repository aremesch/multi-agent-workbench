import { describe, expect, it } from 'vitest';
import { ansiToHtml, stripAnsi } from './ansi.js';

const ESC = '\x1b';

describe('stripAnsi', () => {
  // stripAnsi's regex [A-Za-ln-~] excludes `m` deliberately — SGR is
  // rendered by ansiToHtml separately, so stripAnsi only removes
  // non-SGR CSI (cursor moves, erase, etc.).
  it('removes cursor movement sequences', () => {
    expect(stripAnsi(`${ESC}[2Jcleared`)).toBe('cleared');
    expect(stripAnsi(`x${ESC}[Hy`)).toBe('xy');
  });

  it('removes erase-line and cursor-position sequences', () => {
    expect(stripAnsi(`a${ESC}[Kb${ESC}[10;20Hc`)).toBe('abc');
  });

  it('leaves SGR (ESC[…m) sequences intact', () => {
    // Width-measurement use case: the caller treats SGR as zero-width
    // itself, so stripAnsi must not remove it.
    const input = `${ESC}[31mred${ESC}[0m`;
    expect(stripAnsi(input)).toBe(input);
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

describe('ansiToHtml', () => {
  describe('plain text and escaping', () => {
    it('passes plain text through with HTML-escaping', () => {
      expect(ansiToHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    });

    it('returns empty string for empty input', () => {
      expect(ansiToHtml('')).toBe('');
    });

    it('drops non-SGR CSI sequences entirely', () => {
      expect(ansiToHtml(`before${ESC}[Hafter`)).toBe('beforeafter');
      expect(ansiToHtml(`x${ESC}[2Jy`)).toBe('xy');
    });
  });

  describe('standard 16-color palette', () => {
    it('wraps a red foreground in a styled span', () => {
      expect(ansiToHtml(`${ESC}[31mred${ESC}[0m`)).toBe(
        '<span style="color:#cc0000">red</span>'
      );
    });

    it('applies bright foreground for codes 90-97', () => {
      expect(ansiToHtml(`${ESC}[91mx${ESC}[0m`)).toContain('color:#ef2929');
    });

    it('applies background for codes 40-47', () => {
      expect(ansiToHtml(`${ESC}[42mx${ESC}[0m`)).toContain('background:#4e9a06');
    });

    it('applies bright background for codes 100-107', () => {
      expect(ansiToHtml(`${ESC}[101mx${ESC}[0m`)).toContain('background:#ef2929');
    });

    it('resets default foreground with 39', () => {
      const out = ansiToHtml(`${ESC}[31mred${ESC}[39mdefault`);
      expect(out).toContain('<span style="color:#cc0000">red</span>');
      expect(out.endsWith('default')).toBe(true);
    });

    it('resets default background with 49', () => {
      const out = ansiToHtml(`${ESC}[42mx${ESC}[49my`);
      expect(out).toContain('background:#4e9a06');
      expect(out.endsWith('y')).toBe(true);
    });
  });

  describe('256-color palette', () => {
    it('renders the 6×6×6 cube (ESC[38;5;196m → pure red)', () => {
      // n=196 → idx=180 → r=5,g=0,b=0 → scale(5)=255, scale(0)=0 → rgb(255,0,0)
      expect(ansiToHtml(`${ESC}[38;5;196mx${ESC}[0m`)).toContain('color:rgb(255,0,0)');
    });

    it('renders the grayscale ramp (232-255)', () => {
      expect(ansiToHtml(`${ESC}[38;5;232mx${ESC}[0m`)).toContain('color:rgb(8,8,8)');
      expect(ansiToHtml(`${ESC}[38;5;255mx${ESC}[0m`)).toContain('color:rgb(238,238,238)');
    });

    it('falls back to base palette for indices 0-7', () => {
      expect(ansiToHtml(`${ESC}[38;5;1mx${ESC}[0m`)).toContain('color:#cc0000');
    });

    it('falls back to bright palette for indices 8-15', () => {
      expect(ansiToHtml(`${ESC}[38;5;9mx${ESC}[0m`)).toContain('color:#ef2929');
    });

    it('uses the 256-color path for background (ESC[48;5;N m)', () => {
      expect(ansiToHtml(`${ESC}[48;5;196mx${ESC}[0m`)).toContain('background:rgb(255,0,0)');
    });
  });

  describe('truecolor', () => {
    it('handles foreground ESC[38;2;R;G;B m', () => {
      expect(ansiToHtml(`${ESC}[38;2;10;20;30mx${ESC}[0m`)).toContain('color:rgb(10,20,30)');
    });

    it('handles background ESC[48;2;R;G;B m', () => {
      expect(ansiToHtml(`${ESC}[48;2;255;0;128mx${ESC}[0m`)).toContain(
        'background:rgb(255,0,128)'
      );
    });
  });

  describe('attribute state machine', () => {
    it('combines bold + red in one span', () => {
      expect(ansiToHtml(`${ESC}[1;31mbold-red${ESC}[0mplain`)).toBe(
        '<span style="color:#cc0000;font-weight:bold">bold-red</span>plain'
      );
    });

    it('toggles bold off with 22', () => {
      const out = ansiToHtml(`${ESC}[1mbold${ESC}[22mnot-bold`);
      expect(out).toContain('<span style="font-weight:bold">bold</span>');
      expect(out.endsWith('not-bold')).toBe(true);
    });

    it('toggles italic off with 23', () => {
      const out = ansiToHtml(`${ESC}[3mi${ESC}[23mplain`);
      expect(out).toContain('font-style:italic');
      expect(out.endsWith('plain')).toBe(true);
    });

    it('toggles underline off with 24', () => {
      const out = ansiToHtml(`${ESC}[4mu${ESC}[24mplain`);
      expect(out).toContain('text-decoration:underline');
      expect(out.endsWith('plain')).toBe(true);
    });

    it('22 also clears dim', () => {
      const out = ansiToHtml(`${ESC}[2md${ESC}[22mplain`);
      expect(out).toContain('opacity:0.6');
      expect(out.endsWith('plain')).toBe(true);
    });

    it('emits each attribute independently', () => {
      expect(ansiToHtml(`${ESC}[3mI${ESC}[0m`)).toContain('font-style:italic');
      expect(ansiToHtml(`${ESC}[4mU${ESC}[0m`)).toContain('text-decoration:underline');
      expect(ansiToHtml(`${ESC}[2mD${ESC}[0m`)).toContain('opacity:0.6');
    });
  });

  describe('edge cases', () => {
    it('treats empty CSI (ESC[m) as reset (parameter = [0])', () => {
      // After bold-red, a bare ESC[m should reset and close the span.
      const out = ansiToHtml(`${ESC}[1;31mx${ESC}[my`);
      expect(out).toContain('</span>y');
    });

    it('closes open span when input ends mid-styled run', () => {
      const out = ansiToHtml(`${ESC}[31munterminated`);
      expect(out).toBe('<span style="color:#cc0000">unterminated</span>');
    });
  });
});
