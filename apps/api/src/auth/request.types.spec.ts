import { clientIp, clientUserAgent } from './request.types';
import type { Request } from 'express';

/**
 * Minimal Express Request stand-in.
 *
 * Only `headers`, `ip` and `socket.remoteAddress` are read by the helpers, so a
 * full `Socket` is not constructed; the cast keeps the fixture honest about
 * being a stub rather than claiming to be a live server request.
 */
function request(
  overrides: {
    headers?: Record<string, string>;
    ip?: string;
    remoteAddress?: string;
  } = {},
): Request {
  return {
    headers: overrides.headers ?? {},
    ip: overrides.ip,
    socket: { remoteAddress: overrides.remoteAddress },
  } as unknown as Request;
}

describe('clientIp', () => {
  it('prefers the left-most X-Forwarded-For entry', () => {
    // A trusted proxy appends to the header, so the original client is first.
    const req = request({
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' },
    });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to the socket address', () => {
    expect(clientIp(request({ remoteAddress: '198.51.100.4' }))).toBe('198.51.100.4');
  });

  it('prefers the forwarded header over the socket address', () => {
    const req = request({
      headers: { 'x-forwarded-for': '203.0.113.7' },
      remoteAddress: '10.0.0.1',
    });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('ignores an empty forwarded header', () => {
    expect(clientIp(request({ headers: { 'x-forwarded-for': '' } }))).toBeUndefined();
  });

  it('returns undefined when nothing identifies the client', () => {
    expect(clientIp(request())).toBeUndefined();
  });
});

describe('clientUserAgent', () => {
  it('returns the user agent', () => {
    expect(clientUserAgent(request({ headers: { 'user-agent': 'curl/8.5.0' } }))).toBe(
      'curl/8.5.0',
    );
  });

  it('truncates to the column width', () => {
    const long = 'a'.repeat(400);
    expect(clientUserAgent(request({ headers: { 'user-agent': long } }))).toHaveLength(255);
  });

  it('returns undefined when absent', () => {
    expect(clientUserAgent(request())).toBeUndefined();
    expect(clientUserAgent(request({ headers: { 'user-agent': '' } }))).toBeUndefined();
  });
});
