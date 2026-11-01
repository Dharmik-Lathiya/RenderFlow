import { detectMime, mimeMatches, normaliseMime } from './upload-signature';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x00, 0x00);
const MP3 = bytes(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);

describe('detectMime', () => {
  it('recognises every declared upload type from its magic bytes', () => {
    expect(detectMime(PNG)).toBe('image/png');
    expect(detectMime(JPEG)).toBe('image/jpeg');
    expect(detectMime(PDF)).toBe('application/pdf');
    expect(detectMime(MP3)).toBe('audio/mpeg');

    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(detectMime(webp)).toBe('image/webp');

    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(detectMime(wav)).toBe('audio/wav');

    const mp4 = bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
    expect(detectMime(mp4)).toBe('video/mp4');
  });

  it('returns null for an HTML document disguised as an image', () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    expect(detectMime(html)).toBeNull();
  });

  it('returns null for a truncated file that cannot be identified', () => {
    expect(detectMime(bytes(0x89, 0x50))).toBeNull();
  });
});

describe('mimeMatches', () => {
  it('accepts a declared type that agrees with the bytes', () => {
    expect(mimeMatches('image/png', PNG)).toEqual({
      ok: true,
      declared: 'image/png',
      detected: 'image/png',
    });
  });

  it('rejects a mismatch instead of trusting the Content-Type header', () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');

    expect(mimeMatches('image/png', html)).toEqual({
      ok: false,
      declared: 'image/png',
      detected: null,
    });
  });

  it('normalises common aliases before comparing', () => {
    expect(normaliseMime('image/jpg')).toBe('image/jpeg');
    expect(normaliseMime('audio/mp3')).toBe('audio/mpeg');
    expect(mimeMatches('image/jpg', JPEG).ok).toBe(true);
  });
});
