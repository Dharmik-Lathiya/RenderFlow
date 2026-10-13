'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
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

  return (
    <>
      <Card title="Posts" description="Each one is edited, generated and approved on its own.">
        {posts.isLoading && <Spinner label="Loading posts" />}

        {posts.isError && (
          <ErrorNotice message="Could not load posts." onRetry={() => void posts.refetch()} />
        )}

        {posts.data !== undefined && posts.data.length === 0 && (
          <EmptyState
            title="No posts yet"
            description="Write the first one below, then generate a caption, poster or reel for it."
          />
        )}

        {posts.data !== undefined && posts.data.length > 0 && (
          <ul className={styles.list}>
            {posts.data.map((post) => (
              <li key={post.id} className={styles.listItem}>
                <span>
                  <Link href={`/posts/${post.id}`}>
                    {post.caption?.slice(0, 80) || 'Untitled post'}
                  </Link>
                  <span className={styles.cardDescription}> · {post.type}</span>
                </span>
                <Badge tone={toneFor(post.status)}>{post.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="New post">
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

          <Field label="Caption" id="post-caption" error={captionError}>
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
            Create draft
          </Button>
        </form>
      </Card>
    </>
  );
}

function toneFor(status: string): 'neutral' | 'good' | 'bad' | 'warn' {
  if (status === 'PUBLISHED' || status === 'APPROVED') {
    return 'good';
  }
  if (status === 'FAILED') {
    return 'bad';
  }
  if (status === 'PUBLISHING' || status === 'GENERATING' || status === 'SCHEDULED') {
    return 'warn';
  }
  return 'neutral';
}
