import { redactConnectionUrl } from './redact';

describe('redactConnectionUrl', () => {
  it('strips the password but keeps host, port and db for troubleshooting', () => {
    const redacted = redactConnectionUrl('redis://user:hunter2@cache:6379/2');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('cache:6379');
    expect(redacted).toContain('/2');
  });

  it('strips the username too', () => {
    expect(redactConnectionUrl('redis://admin:s3cret@cache:6379')).not.toContain('admin');
  });

  it('handles a postgres url', () => {
    const redacted = redactConnectionUrl('postgresql://renderflow:pw@postgres:5432/renderflow');
    expect(redacted).not.toContain('pw@');
    expect(redacted).toContain('postgres:5432');
    expect(redacted).toContain('renderflow');
  });

  it('leaves a credential-free url usable', () => {
    expect(redactConnectionUrl('redis://localhost:6379')).toContain('localhost:6379');
  });

  it('never echoes an unparseable input, because it cannot be inspected', () => {
    expect(redactConnectionUrl('hunter2 and more secrets')).toBe('<unparseable connection url>');
  });

  it('handles an empty string', () => {
    expect(redactConnectionUrl('')).toBe('<unparseable connection url>');
  });
});
