/**
 * Magic-byte detection for the upload allow-list.
 *
 * The browser's `Content-Type` is a claim, not evidence. A client can declare
 * `image/png` and upload an HTML document; S3 stores it with the declared type
 * and a presigned download then serves it from the bucket origin. Checking the
 * first bytes closes the stored-XSS path without pulling a MIME database into
 * the API.
 *
 * This is intentionally a small allow-list that mirrors `ALLOWED_UPLOAD_MIME` in
 * `studio.service.ts`. A format that is not here is not uploadable.
 */

export const SNIFF_BYTES = 8192;

export type DetectedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'video/mp4'
  | 'audio/mpeg'
  | 'audio/wav'
  | 'application/pdf';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Returns the real MIME type, or `null` when the bytes do not match a supported
 * format. `null` is rejected by the caller; it is never treated as "unknown but
 * probably fine".
 */
export function detectMime(bytes: Uint8Array): DetectedMime | null {
  if (bytes.length < 12) {
    return null;
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') {
      return 'image/webp';
    }
    if (form === 'WAVE') {
      return 'audio/wav';
    }
  }

  // ISO base media files carry the box type at offset 4: `....ftyp`.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    return 'video/mp4';
  }

  if (ascii(bytes, 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }

  // MPEG-1/2 audio frame sync: 11 set bits, with a valid layer (bits 1-2 are
  // not zero). Checking the sync alone would accept any file starting 0xFFE.
  if (
    bytes[0] === 0xff &&
    bytes[1] !== undefined &&
    (bytes[1] & 0xe0) === 0xe0 &&
    (bytes[1] & 0x06) !== 0
  ) {
    return 'audio/mpeg';
  }

  if (ascii(bytes, 0, 5) === '%PDF-') {
    return 'application/pdf';
  }

  return null;
}

/** Normalises the aliases clients commonly send before comparing. */
export function normaliseMime(mime: string): string {
  const lower = mime.trim().toLowerCase();
  if (lower === 'image/jpg' || lower === 'image/pjpeg') {
    return 'image/jpeg';
  }
  if (lower === 'audio/mp3' || lower === 'audio/mpeg3') {
    return 'audio/mpeg';
  }
  return lower;
}

export interface MimeCheck {
  ok: boolean;
  declared: string;
  detected: DetectedMime | null;
}

export function mimeMatches(declared: string, bytes: Uint8Array): MimeCheck {
  const detected = detectMime(bytes);
  return {
    ok: detected !== null && normaliseMime(declared) === detected,
    declared: normaliseMime(declared),
    detected,
  };
}
