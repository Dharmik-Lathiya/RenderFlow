/**
 * Credential redaction for connection strings.
 *
 * Lives in libs/common because both the logging boundary (libs/observability) and
 * the queue config (libs/queue) need it, and neither should depend on the other.
 *
 * A connection URL routinely embeds credentials
 * (`redis://user:secret@host`, `postgres://u:p@host/db`), so it must never be
 * logged verbatim.
 */

/**
 * Returns `url` with any username and password replaced by `***`, keeping host,
 * port, path and scheme so the value is still useful for troubleshooting.
 *
 * Never throws: an unparseable input is replaced wholesale, because the only safe
 * response to "I cannot inspect this string" is not to print it.
 */
export function redactConnectionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') {
      parsed.password = '***';
    }
    if (parsed.username !== '') {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch {
    return '<unparseable connection url>';
  }
}
