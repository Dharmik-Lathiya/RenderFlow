'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { ApiClientError, type Asset } from '@renderflow/api-client';

import { useApi } from '../../../../lib/providers';
import { Icon } from '../../../../components/icons';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Field,
  PageHeader,
  Spinner,
} from '../../../../components/ui';
import { JobProgressView, useJobProgress } from '../../../posts/[postId]/job-progress';
import styles from '../../../../components/ui.module.css';
import festivalStyles from './festival-studio.module.css';

/**
 * The festival campaign builder.
 *
 * Order is the product: pick the occasion, then the template, then describe the
 * offer. The price is quoted by the server before the button is enabled, because
 * a client that calculates credits from a table it cannot read would eventually
 * advertise a price the ledger does not charge (AGENTS.md section 5 rule 7).
 *
 * The job itself is an ordinary generation job: the API reserves credits and
 * writes the outbox event in one transaction, and this page watches the same SSE
 * endpoint every other generation uses.
 */

type Language = 'english' | 'hindi' | 'both';

export function FestivalStudio({ campaignId }: { campaignId: string }) {
  const api = useApi();
  const client = useQueryClient();

  const occasions = useQuery({
    queryKey: ['festival-occasions'],
    queryFn: () => api.festival.occasions(),
  });

  const [occasionId, setOccasionId] = useState<string | null>(null);
  const selectedOccasionId = occasionId ?? occasions.data?.[0]?.id ?? null;

  const templates = useQuery({
    queryKey: ['festival-templates', selectedOccasionId],
    queryFn: () => api.festival.templates(selectedOccasionId ?? ''),
    enabled: selectedOccasionId !== null,
  });

  const [templateId, setTemplateId] = useState<string | null>(null);
  const template =
    templates.data?.find((row) => row.id === templateId) ?? templates.data?.[0] ?? null;

  const [offerText, setOfferText] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [language, setLanguage] = useState<Language>('both');
  const [includeReel, setIncludeReel] = useState(false);

  const estimate = useQuery({
    queryKey: ['festival-estimate', includeReel],
    queryFn: () => api.festival.estimate(includeReel),
  });

  const credits = useQuery({
    queryKey: ['credits'],
    queryFn: () => api.credits.balance(),
  });

  const [jobId, setJobId] = useState<string | null>(null);
  const [postId, setPostId] = useState<string | null>(null);
  const progress = useJobProgress(jobId);
  const completed = progress.job?.status === 'COMPLETED';

  /**
   * One key per intended generation.
   *
   * Rotated only after a successful create: a double click and a retry after a
   * dropped response are the same intent, while the next deliberate generation
   * is a new one. A random key per click would let a double click reserve twice.
   */
  const intentKey = useRef<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      intentKey.current ??= crypto.randomUUID();
      return api.festival.create(
        campaignId,
        {
          occasionId: selectedOccasionId ?? '',
          templateId: template?.id,
          offerText: offerText.trim(),
          ctaText: ctaText.trim(),
          language,
          includeReel,
        },
        intentKey.current,
      );
    },
    retry: false,
    onSuccess: async (result) => {
      intentKey.current = null;
      setJobId(result.jobId);
      setPostId(result.postId);
      // The reservation moved credits out of `available` before this response,
      // so both the shell (auth.me) and this page's quote are stale.
      await Promise.all([
        client.invalidateQueries({ queryKey: ['posts', campaignId] }),
        client.invalidateQueries({ queryKey: ['credits'] }),
        client.invalidateQueries({ queryKey: ['me'] }),
      ]);
    },
  });

  useEffect(() => {
    if (!completed || postId === null) {
      return;
    }

    // The post was fetched while it was still GENERATING. Completion is the
    // moment its caption, status and asset rows become final, so this is where a
    // refresh is actually meaningful.
    void client.invalidateQueries({ queryKey: ['post', postId] });
  }, [completed, postId, client]);

  const post = useQuery({
    queryKey: ['post', postId],
    queryFn: () => api.posts.detail(postId ?? ''),
    enabled: postId !== null,
  });

  const result = useQuery({
    queryKey: ['festival-result', postId],
    queryFn: async () => {
      const assets = await api.posts.assets(postId ?? '');
      return Promise.all(
        assets.map(async (asset) => ({
          asset,
          url: (await api.assets.download(asset.id)).url,
        })),
      );
    },
    enabled: postId !== null && completed,
  });

  const canGenerate =
    selectedOccasionId !== null &&
    template !== null &&
    offerText.trim().length >= 3 &&
    ctaText.trim().length >= 1 &&
    !create.isPending;

  return (
    <>
      <PageHeader
        eyebrow="Campaign"
        title="Festival campaign"
        description="Pick an occasion and a template, describe the offer, and RenderFlow writes the caption and renders the poster and reel in your brand's colours."
        actions={
          <>
            <Link href={`/campaigns/${campaignId}`} className={styles.button}>
              <Icon name="chevronLeft" size={15} />
              Campaign
            </Link>
            <Link href="/calendar" className={styles.button}>
              <Icon name="calendar" size={15} />
              Calendar
            </Link>
          </>
        }
      />

      {occasions.isError && (
        <ErrorNotice
          message="Could not load the festival catalogue."
          onRetry={() => void occasions.refetch()}
        />
      )}

      {occasions.isLoading && <Spinner label="Loading festival occasions" />}

      <div className={styles.formLayout}>
        <div className={styles.dashboardColumn}>
          <Card
            title="1. Choose an occasion"
            description="The occasion sets the copy, palette and greetings."
          >
            {occasions.data !== undefined && occasions.data.length === 0 && (
              <p className={styles.cardDescription}>
                No festival occasions are published. Run <code>pnpm db:seed</code> and reload.
              </p>
            )}

            <div className={festivalStyles.choiceGrid} role="group" aria-label="Occasions">
              {(occasions.data ?? []).map((occasion) => {
                const selected = occasion.id === selectedOccasionId;
                return (
                  <button
                    key={occasion.id}
                    type="button"
                    className={`${festivalStyles.choice} ${
                      selected ? festivalStyles.choiceActive : ''
                    }`}
                    aria-pressed={selected}
                    aria-label={
                      selected ? `${occasion.displayName} (selected)` : occasion.displayName
                    }
                    onClick={() => {
                      setOccasionId(occasion.id);
                      setTemplateId(null);
                    }}
                  >
                    <span className={festivalStyles.occasionName}>{occasion.displayName}</span>
                    <span className={festivalStyles.choiceHint}>
                      {selected ? 'Selected' : 'Choose'}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card
            title="2. Choose a template"
            description="The preview shows the palette; the renderer uses the full descriptor stored on the server."
          >
            {templates.isLoading && selectedOccasionId !== null && (
              <Spinner label="Loading templates" />
            )}

            {templates.isError && (
              <ErrorNotice
                message="Could not load templates for that occasion."
                onRetry={() => void templates.refetch()}
              />
            )}

            {templates.data !== undefined && templates.data.length === 0 && (
              <p className={styles.cardDescription}>No active template for that occasion.</p>
            )}

            <div className={festivalStyles.choiceGrid} role="group" aria-label="Templates">
              {(templates.data ?? []).map((row) => {
                const selected = row.id === template?.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={`${festivalStyles.choice} ${
                      selected ? festivalStyles.choiceActive : ''
                    }`}
                    aria-pressed={selected}
                    aria-label={
                      selected ? `${row.name} template (selected)` : `${row.name} template`
                    }
                    onClick={() => setTemplateId(row.id)}
                  >
                    <span
                      className={festivalStyles.swatch}
                      style={{
                        background: `linear-gradient(135deg, ${row.colorScheme.primary}, ${row.colorScheme.background})`,
                      }}
                      aria-hidden="true"
                    />
                    <span className={festivalStyles.occasionName}>{row.name}</span>
                    <span className={festivalStyles.choiceHint}>
                      {row.dimensions.width}×{row.dimensions.height}
                      {row.reelDurationSeconds === null
                        ? ''
                        : ` · ${row.reelDurationSeconds}s reel`}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card
            title="3. Describe the offer"
            description="This is what the copy will be built around."
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (canGenerate) {
                  create.mutate();
                }
              }}
              noValidate
            >
              <Field
                label="Offer"
                id="festival-offer"
                hint="What is the customer getting? Keep it under 500 characters."
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    aria-describedby={describedBy}
                    value={offerText}
                    maxLength={500}
                    onChange={(event) => setOfferText(event.target.value)}
                    placeholder="20% off every box of mithai this Diwali"
                  />
                )}
              </Field>

              <Field
                label="Call to action"
                id="festival-cta"
                hint="What should they do next? A shop link, a phone number, a date."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={ctaText}
                    maxLength={200}
                    onChange={(event) => setCtaText(event.target.value)}
                    placeholder="Order before Friday at renderflow.store"
                  />
                )}
              </Field>

              <Field
                label="Language"
                id="festival-language"
                hint="Both writes English with a Hindi line where the template has room."
              >
                {({ id, describedBy }) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as Language)}
                  >
                    <option value="english">English</option>
                    <option value="hindi">Hindi</option>
                    <option value="both">Both</option>
                  </select>
                )}
              </Field>

              <label className={festivalStyles.checkRow}>
                <input
                  type="checkbox"
                  checked={includeReel}
                  onChange={(event) => setIncludeReel(event.target.checked)}
                />
                <span>
                  Include a 15-second reel
                  <span className={festivalStyles.choiceHint}>
                    The poster is animated with the template palette and brand name.
                  </span>
                </span>
              </label>

              {create.isError && <ErrorNotice message={createErrorMessage(create.error)} />}

              <Button
                type="submit"
                variant="primary"
                busy={create.isPending}
                disabled={!canGenerate}
              >
                <Icon name="sparkles" size={15} />
                Generate festival post
              </Button>
            </form>
          </Card>
        </div>

        <div className={styles.dashboardColumn}>
          <Card
            title="Cost estimate"
            description="Quoted by the server before anything is reserved."
          >
            {estimate.isLoading && <Spinner label="Loading estimate" />}

            {estimate.isError && (
              <ErrorNotice
                message="Could not load the price. Generation is disabled until it loads."
                onRetry={() => void estimate.refetch()}
              />
            )}

            {estimate.data !== undefined && (
              <>
                <p className={festivalStyles.price}>
                  {estimate.data.total} <span>credits</span>
                </p>
                <p className={styles.cardDescription}>
                  {estimate.data.includeReel
                    ? `This will use ${estimate.data.total} credits (poster: ${estimate.data.poster}, reel: ${estimate.data.reelAddOn}).`
                    : `This will use ${estimate.data.poster} credits for the poster and caption.`}
                </p>
                <p className={styles.cardDescription}>
                  Credits are reserved when you press Generate and only captured if the job
                  finishes. A failure is refunded.
                </p>
                {credits.data !== undefined && (
                  <p className={styles.cardDescription}>
                    Your balance: {credits.data.wallet.available} credits · After generation:{' '}
                    {Math.max(0, credits.data.wallet.available - estimate.data.total)} credits
                  </p>
                )}
              </>
            )}
          </Card>

          {jobId !== null && (
            <Card title="Progress" description="The same stage stream every generation uses.">
              <JobProgressView progress={progress} />

              {progress.job?.status === 'FAILED' && postId !== null && (
                <p className={styles.cardDescription}>
                  The post was closed and the reservation was refunded. Adjust the offer or template
                  and try again.
                </p>
              )}
            </Card>
          )}

          {completed && (
            <Card
              title="Result"
              description="The caption and assets were attached to a new post in this campaign."
              actions={
                postId === null ? undefined : (
                  <Link href={`/posts/${postId}`} className={styles.minorLink}>
                    Open post
                    <Icon name="arrowUpRight" size={12} />
                  </Link>
                )
              }
            >
              {post.data !== undefined && (
                <>
                  <Badge tone={post.data.status === 'READY' ? 'good' : 'warn'}>
                    {post.data.status}
                  </Badge>
                  {post.data.caption !== null && (
                    <p className={styles.cardDescription}>{post.data.caption}</p>
                  )}
                  {post.data.hashtags !== '' && (
                    <p className={styles.cardDescription}>{post.data.hashtags}</p>
                  )}
                </>
              )}

              {result.isLoading && <Spinner label="Loading assets" />}

              {result.isError && (
                <ErrorNotice
                  message="The post is ready, but its download links could not be loaded."
                  onRetry={() => void result.refetch()}
                />
              )}

              {result.data !== undefined && (
                <ul className={styles.list}>
                  {result.data.map(({ asset, url }) => (
                    <li key={asset.id} className={styles.listItem}>
                      <span>
                        <strong>{labelForAsset(asset)}</strong>
                        <span className={styles.cardDescription}>
                          {' '}
                          {asset.mime} · {(asset.sizeBytes / 1024).toFixed(0)} KB
                        </span>
                      </span>
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.minorLink}
                      >
                        Download
                        <Icon name="arrowUpRight" size={12} />
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              <p className={styles.cardDescription}>
                Download links expire after five minutes. Open the post from the campaign any time
                to get a fresh one.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function createErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.isInsufficientCredits) {
      return 'Not enough credits for that template. Reduce the reel option or top up.';
    }
    if (error.code === 'MODERATION_REJECTED') {
      return error.message;
    }
    return error.message;
  }
  return 'Could not start that festival generation. Nothing was reserved.';
}

function labelForAsset(asset: Asset): string {
  const last = asset.storageKey.split('/').pop();
  return last ?? asset.type;
}
