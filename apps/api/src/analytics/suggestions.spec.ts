import { suggestNextPosts, type PerformanceRow } from './suggestions';

/**
 * "What to post next" (PROJECT.md Phase 9).
 *
 * The ranking is deterministic and cites its number, so these tests assert the
 * ranking and the day it picks rather than the prose. A suggestion that changes
 * when nothing changed is indistinguishable from a random one.
 */

function row(overrides: Partial<PerformanceRow>): PerformanceRow {
  return {
    type: 'REEL',
    platform: 'instagram',
    likes: 0,
    comments: 0,
    reach: 0,
    clicks: 0,
    publishedAt: new Date('2026-05-07T10:00:00Z'),
    ...overrides,
  };
}

describe('suggestNextPosts', () => {
  it('starts a campaign with no data on the three formats worth testing', () => {
    const suggestions = suggestNextPosts([]);

    expect(suggestions.map((suggestion) => suggestion.type)).toEqual([
      'REEL',
      'CAROUSEL',
      'CAPTION',
    ]);
    expect(suggestions[0]?.rationale).toContain('no performance data');
  });

  it('ignores publications whose metrics have not arrived', () => {
    // A zero-reach row is "not synced yet", not "nobody saw it". Counting it as
    // a zero would make the newest post look like the worst format.
    const suggestions = suggestNextPosts([
      row({ type: 'CAPTION', reach: 0 }),
      row({ type: 'REEL', likes: 100, comments: 10, reach: 1_000 }),
    ]);

    expect(suggestions[0]?.title).toContain('reel');
    expect(suggestions[0]?.rationale).toContain('11.0%');
  });

  it('ranks by engagement rate, not raw likes', () => {
    const suggestions = suggestNextPosts([
      // More likes, but a much larger audience: 2% engagement.
      row({ type: 'CAPTION', likes: 200, comments: 0, reach: 10_000 }),
      // Fewer likes on a small audience: 20% engagement, the better format.
      row({ type: 'REEL', likes: 90, comments: 10, reach: 500 }),
    ]);

    expect(suggestions[0]?.type).toBe('REEL');
  });

  it('picks the strongest weekday from when posts actually went out', () => {
    const suggestions = suggestNextPosts([
      row({
        type: 'REEL',
        likes: 100,
        comments: 10,
        reach: 1_000,
        publishedAt: new Date('2026-05-07T10:00:00Z'), // Thursday
      }),
      row({
        type: 'CAPTION',
        likes: 10,
        comments: 1,
        reach: 1_000,
        publishedAt: new Date('2026-05-04T10:00:00Z'), // Monday
      }),
    ]);

    expect(suggestions[1]?.title).toContain('Thursday');
  });

  it('names an untested format as the clearest gap', () => {
    const suggestions = suggestNextPosts([
      row({ type: 'REEL', likes: 100, comments: 10, reach: 1_000 }),
      row({ type: 'CAPTION', likes: 10, comments: 1, reach: 1_000 }),
    ]);

    expect(suggestions[2]?.type).toBe('POSTER');
    expect(suggestions[2]?.rationale).toContain('no poster');
  });

  it('rotates in the second-best format once every format has been tried', () => {
    const suggestions = suggestNextPosts([
      row({ type: 'REEL', likes: 100, comments: 10, reach: 1_000 }),
      row({ type: 'CAPTION', likes: 50, comments: 5, reach: 1_000 }),
      row({ type: 'POSTER', likes: 20, comments: 2, reach: 1_000 }),
      row({ type: 'CAROUSEL', likes: 10, comments: 1, reach: 1_000 }),
    ]);

    expect(suggestions[2]?.type).toBe('CAPTION');
    expect(suggestions[2]?.title).toContain('Rotate');
  });

  it('ignores a post type the generator cannot produce', () => {
    const suggestions = suggestNextPosts([
      row({ type: 'MEME', likes: 1_000, comments: 100, reach: 1_000 }),
      row({ type: 'REEL', likes: 10, comments: 1, reach: 1_000 }),
    ]);

    expect(suggestions[0]?.type).toBe('REEL');
  });

  it('does not pick a weekday when no publication recorded one', () => {
    const suggestions = suggestNextPosts([
      row({ type: 'REEL', likes: 10, comments: 1, reach: 100, publishedAt: null }),
    ]);

    expect(suggestions.some((suggestion) => suggestion.title.includes('Schedule'))).toBe(false);
  });
});
