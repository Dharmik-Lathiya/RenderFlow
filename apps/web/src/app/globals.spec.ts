import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Both palettes are shipped, so both have to meet the same contrast floor.
 *
 * Parsing the stylesheet keeps the tokens in one place: a test that duplicated
 * the hex values would keep passing after someone changed the palette.
 */
describe('global theme tokens', () => {
  const css = readFileSync(path.join(__dirname, 'globals.css'), 'utf8');

  const themes = [
    { name: 'dark', selector: ':root {' },
    { name: 'light', selector: ":root[data-theme='light'] {" },
  ] as const;

  it('keeps text and status colours readable on both backgrounds', () => {
    for (const { name, selector } of themes) {
      const tokens = readTokens(selector);

      expectContrast(tokens, 'fg', 'bg', 7, `${name} body text`);
      expectContrast(tokens, 'muted', 'bg', 4.5, `${name} muted text`);
      expectContrast(tokens, 'muted', 'bg-raised', 4.5, `${name} muted text on cards`);
      expectContrast(tokens, 'accent', 'bg', 4.5, `${name} links`);
      expectContrast(tokens, 'accent-fg', 'accent', 4.5, `${name} primary button`);
      expectContrast(tokens, 'danger', 'bg', 4.5, `${name} errors`);
      expectContrast(tokens, 'success', 'bg', 4.5, `${name} success text`);
      expectContrast(tokens, 'warning', 'bg', 4.5, `${name} warnings`);
    }
  });

  function readTokens(selector: string): Record<string, string> {
    const start = css.indexOf(selector);

    if (start === -1) {
      throw new Error(`globals.css is missing the ${selector} block`);
    }

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    const block = css.slice(open + 1, close);
    const tokens: Record<string, string> = {};

    for (const match of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
      const [, name, value] = match;

      if (name !== undefined && value !== undefined) {
        tokens[name] = value;
      }
    }

    return tokens;
  }
});

function expectContrast(
  tokens: Record<string, string>,
  foreground: string,
  background: string,
  minimum: number,
  label: string,
): void {
  const fg = token(tokens, foreground);
  const bg = token(tokens, background);
  const fgLuminance = relativeLuminance(fg);
  const bgLuminance = relativeLuminance(bg);
  const ratio =
    (Math.max(fgLuminance, bgLuminance) + 0.05) / (Math.min(fgLuminance, bgLuminance) + 0.05);

  // `expect` takes no message argument under Jest; throw here so a failure says
  // which pair and theme broke the floor instead of only printing a number.
  if (ratio < minimum) {
    throw new Error(`${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
  }
}

function token(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];

  if (value === undefined) {
    throw new Error(`missing --${name}`);
  }

  return value;
}

function relativeLuminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/.{2}/g) ?? []).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
