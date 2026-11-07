'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { Icon } from '../../../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Spinner,
} from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * The posts in one campaign.
 *
 * A new post starts as a DRAFT: the user writes it, generates what they want,
 * and only then does it go to an APPROVER. Creating a post that is already
 * approved would collapse two roles and a review into one click.
 */
export function CampaignPosts({ campaignId }: { campaignId: string }) {
  const api = useApi();
  const client = useQueryClient();

  const posts = useQuery({
    queryKey: ['posts', campaignId],
    queryFn: () => api.campaigns.posts(campaignId),
  });

  const [type, setType] = useState('CAPTION');
  const [caption, setCaption] = useState('');
  const [touched, setTouched] = useState(false);

  const captionError =
    touched && caption.trim().length > 2_000 ? 'That caption is too long.' : undefined;

  const create = useMutation({
    mutationFn: () => api.posts.create({ campaignId, type, caption: caption.trim(), hashtags: '' }),
    retry: false,
    onSuccess: async () => {
      setCaption('');
      setTouched(false);
      await client.invalidateQueries({ queryKey: ['posts', campaignId] });
    },
  });

  const list = posts.data ?? [];

  return (
    <div className={styles.dashboardGrid}>
      <div className={styles.dashboardColumn}>
        <Card
          title="Posts"
          description="Each one is edited, generated and approved on its own."
          actions={
            <span className={styles.cardDescription}>
              {posts.data === undefined
                ? 'Loading'
                : `${list.length} ${list.length === 1 ? 'post' : 'posts'}`}
            </span>
          }
        >
          {posts.isLoading && <Spinner label="Loading posts" />}

          {posts.isError && (
            <ErrorNotice message="Could not load posts." onRetry={() => void posts.refetch()} />
          )}

          {posts.data !== undefined && posts.data.length === 0 && (
            <EmptyState
              icon={<Icon name="fileText" size={18} />}
              title="No posts yet"
              description="Write the first one beside this panel, then generate a caption, poster or reel for it."
            />
          )}

          {list.length > 0 && (
            <ul className={styles.list}>
              {list.map((post) => (
                <li key={post.id} className={styles.listItem}>
                  <span className={styles.row}>
                    <span className={styles.typeChip}>{post.type}</span>
                    <Link href={`/posts/${post.id}`} className={styles.postLink}>
                      {post.caption?.slice(0, 90) || 'Untitled post'}
                    </Link>
                  </span>
                  <span className={styles.row}>
                    <Badge
                      tone={toneFor(post.status)}
                      pulse={post.status === 'GENERATING' || post.status === 'PUBLISHING'}
                    >
                      {post.status}
                    </Badge>
                    <Link
                      href={`/posts/${post.id}`}
                      className={styles.minorLink}
                      aria-label={`Open ${post.type.toLowerCase()} post`}
                    >
                      Edit
                      <Icon name="arrowUpRight" size={12} />
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className={styles.dashboardColumn}>
        <Card
          title="New post"
          description="Start with a caption or a visual format. Generation comes next."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setTouched(true);

              if (caption.trim().length > 2_000) {
                return;
              }

              create.mutate();
            }}
            noValidate
          >
            {create.isError && <ErrorNotice message="Could not create the post." />}

            <Field label="Kind" id="post-type" hint="What you will generate for this post.">
              {({ id, describedBy }) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  <option value="CAPTION">Caption</option>
                  <option value="POSTER">Poster</option>
                  <option value="CAROUSEL">Carousel</option>
                  <option value="REEL">Reel</option>
                </select>
              )}
            </Field>

            <Field
              label="Caption"
              id="post-caption"
              error={captionError}
              hint="Optional. You can write it now or generate it after the draft exists."
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  onBlur={() => setTouched(true)}
                />
              )}
            </Field>

            <Button type="submit" variant="primary" busy={create.isPending}>
              <Icon name="plus" size={15} />
              Create draft
            </Button>
          </form>
        </Card>

        <Card title="Review path" description="A draft cannot publish itself.">
          <ol className={styles.miniList}>
            <li className={styles.miniItem}>
              <span className={styles.miniDot} aria-hidden="true" />
              <span className={styles.miniCopy}>
                <span className={styles.miniTitle}>1. Write and generate</span>
                <span className={styles.miniMeta}>
                  A generation reserves credits first and refunds them if it fails.
                </span>
              </span>
            </li>
            <li className={styles.miniItem}>
              <span className={styles.miniDot} aria-hidden="true" />
              <span className={styles.miniCopy}>
                <span className={styles.miniTitle}>2. Approve</span>
                <span className={styles.miniMeta}>
                  An APPROVER decides what the world sees. Editing after approval bumps the version.
                </span>
              </span>
            </li>
            <li className={styles.miniItem}>
              <span className={styles.miniDot} aria-hidden="true" />
              <span className={styles.miniCopy}>
                <span className={styles.miniTitle}>3. Schedule</span>
                <span className={styles.miniMeta}>
                  Pick an account and a time; the publisher claims it from the calendar.
                </span>
              </span>
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}

type BadgeTone = 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'teal';

/** Post states mapped per `DESIGN.md` section 2.3. */
function toneFor(status: string): BadgeTone {
  if (status === 'READY') {
    return 'teal';
  }
  if (status === 'PUBLISHED' || status === 'APPROVED') {
    return 'good';
  }
  if (status === 'FAILED') {
    return 'bad';
  }
  if (status === 'SCHEDULED') {
    return 'warn';
  }
  if (status === 'PUBLISHING' || status === 'GENERATING') {
    return 'info';
  }
  return 'neutral';
}
