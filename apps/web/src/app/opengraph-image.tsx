import { ImageResponse } from 'next/og';

/**
 * The link preview card.
 *
 * Without one, every shared link renders as a bare URL - which matters for a
 * product whose distribution is other people posting about it.
 *
 * Drawn in code rather than committed as a binary so it cannot drift from the
 * brand tokens, and it ships no font file: `ImageResponse` renders with its
 * bundled default.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RenderFlow — a month of marketing, made in an afternoon';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        padding: '80px',
        background: '#0f172a',
        color: '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 40 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ width: 56, height: 16, borderRadius: 8, background: '#2563eb' }} />
          <div style={{ width: 72, height: 16, borderRadius: 8, background: '#60a5fa' }} />
          <div style={{ width: 48, height: 16, borderRadius: 8, background: '#ea580c' }} />
        </div>
        <div style={{ fontSize: 40, fontWeight: 600 }}>RenderFlow</div>
      </div>

      <div style={{ fontSize: 76, lineHeight: 1.05, letterSpacing: -2, maxWidth: 900 }}>
        A month of marketing. Made in an afternoon.
      </div>

      <div style={{ marginTop: 32, fontSize: 30, color: '#94a3b8', maxWidth: 900 }}>
        AI marketing studio and social scheduler. Pay per asset, refunded when generation fails.
      </div>
    </div>,
    size,
  );
}
