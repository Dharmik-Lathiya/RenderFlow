/**
 * Renders a JSON-LD block for structured data.
 *
 * Server component by default: the script is emitted straight into the server
 * HTML, which is what crawlers read. The payload comes from `lib/seo`, built
 * from constants this repository owns - not from user input - so the
 * `dangerouslySetInnerHTML` is a fixed string, never a template, and cannot
 * carry injected markup.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}
