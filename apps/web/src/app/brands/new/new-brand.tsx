'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { Icon } from '../../../components/icons';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  PageHeader,
  Spinner,
  StatCard,
} from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * Onboarding: create the first brand.
 *
 * Every field here is one the planner actually reads. The defaults are filled in
 * rather than left blank, because a brand created with an empty voice produces
 * posts that sound like every other brand - and the user cannot tell whether that
 * is the model's fault or theirs.
 */
export function NewBrand() {
  const api = useApi();
  const client = useQueryClient();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    retry: false,
  });

  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [tone, setTone] = useState('friendly and direct');
  const [touched, setTouched] = useState(false);

  const nameError = touched && name.trim() === '' ? 'Give the brand a name.' : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.brands.create({
        workspaceId: workspaces.data?.[0]?.id ?? '',
        name: name.trim(),
        ...(industry.trim() === '' ? {} : { industry: industry.trim() }),
        tone: tone.trim(),
        colors: [],
        languages: ['en'],
      }),
    retry: false,
    onSuccess: async (brand) => {
      await client.invalidateQueries({ queryKey: ['brands'] });
      window.location.href = `/brands/${brand.id}`;
    },
  });

  if (workspaces.isLoading) {
    return <Spinner label="Loading your workspace" />;
  }

  const workspace = workspaces.data?.[0];
  const previewName = name.trim() === '' ? 'Your brand' : name.trim();

  return (
    <>
      <PageHeader
        eyebrow="Brand library"
        title="New brand"
        description="A brand carries the voice every post is written in. Set it once and the planner applies it everywhere."
        actions={
          <Link href="/brands" className={styles.button}>
            <Icon name="chevronLeft" size={15} />
            Back to brands
          </Link>
        }
      />

      <div className={styles.dashboardGrid}>
        <div className={styles.dashboardColumn}>
          <Card
            title="Brand details"
            description="Only the name is required. The rest sharpens every caption and visual."
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setTouched(true);

                if (name.trim() === '' || workspace === undefined) {
                  return;
                }

                create.mutate();
              }}
              noValidate
            >
              {create.isError && <ErrorNotice message="Could not create the brand." />}

              {workspaces.isError && (
                <ErrorNotice
                  message="Could not load your workspace."
                  onRetry={() => void workspaces.refetch()}
                />
              )}

              <Field label="Name" id="brand-name" error={nameError}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onBlur={() => setTouched(true)}
                  />
                )}
              </Field>

              <Field
                label="Industry"
                id="brand-industry"
                hint="Optional. Helps the planner pick examples."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={industry}
                    onChange={(event) => setIndustry(event.target.value)}
                  />
                )}
              </Field>

              <Field
                label="Tone of voice"
                id="brand-tone"
                hint="How the brand should sound. This is read on every post."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={tone}
                    onChange={(event) => setTone(event.target.value)}
                  />
                )}
              </Field>

              <Button type="submit" variant="primary" busy={create.isPending}>
                <Icon name="plus" size={15} />
                Create brand
              </Button>
            </form>
          </Card>
        </div>

        <div className={styles.dashboardColumn}>
          <Card title="Preview" description="How this brand reads inside the studio.">
            <div className={styles.brandPreview}>
              <span className={styles.brandPreviewAvatar} aria-hidden="true">
                {initialsOf(previewName)}
              </span>
              <span className={styles.brandPreviewCopy}>
                <span className={styles.brandPreviewName}>{previewName}</span>
                <span className={styles.brandPreviewMeta}>
                  {industry.trim() === '' ? 'Industry not set' : industry.trim()}
                </span>
              </span>
              <span className={styles.brandPreviewBadge}>Draft</span>
            </div>
            <p className={styles.brandPreviewTone}>
              <Icon name="sparkles" size={14} />
              {tone.trim() === ''
                ? 'Add a tone of voice so every caption sounds like you.'
                : tone.trim()}
            </p>
          </Card>

          <Card title="What happens next" description="The first campaign takes about a minute.">
            <ol className={styles.miniList}>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>1. Plan a campaign</span>
                  <span className={styles.miniMeta}>
                    Describe the goal and the planner drafts the first post.
                  </span>
                </span>
              </li>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>2. Generate the assets</span>
                  <span className={styles.miniMeta}>
                    Captions, posters and reels reserve credits before they run.
                  </span>
                </span>
              </li>
              <li className={styles.miniItem}>
                <span className={styles.miniDot} aria-hidden="true" />
                <span className={styles.miniCopy}>
                  <span className={styles.miniTitle}>3. Approve and schedule</span>
                  <span className={styles.miniMeta}>
                    An APPROVER signs off, then the publisher takes it from there.
                  </span>
                </span>
              </li>
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

/** The brands index, which onboarding links back to. */
export function BrandList() {
  const api = useApi();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.workspaces.list(),
    retry: false,
  });
  const workspaceId = workspaces.data?.[0]?.id;
  const brands = useQuery({
    queryKey: ['brands', workspaceId],
    queryFn: () => (workspaceId === undefined ? Promise.resolve([]) : api.brands.list(workspaceId)),
    enabled: workspaceId !== undefined,
  });

  const list = brands.data ?? [];
  const industries = new Set(
    list.map((brand) => brand.industry).filter((industry) => industry !== null),
  );
  const languages = new Set(list.flatMap((brand) => brand.languages));
  const voiceReady = list.filter(
    (brand) => brand.tone !== null && brand.tone !== undefined && brand.tone.trim() !== '',
  ).length;

  return (
    <>
      <PageHeader
        eyebrow="Brand library"
        title="Brands"
        description="Every brand carries a voice, a palette and a language set. The planner reads all three before it writes a single post."
        actions={
          <Link href="/brands/new" className={`${styles.button} ${styles.primary}`}>
            <Icon name="plus" size={15} />
            New brand
          </Link>
        }
      />

      <div className={styles.kpiGrid}>
        <StatCard
          label="Brands"
          value={brands.data === undefined ? '—' : list.length}
          hint="in this workspace"
          icon={<Icon name="brands" />}
        />
        <StatCard
          label="Industries"
          value={brands.data === undefined ? '—' : industries.size}
          hint="distinct categories"
          icon={<Icon name="sparkles" />}
          tone="info"
        />
        <StatCard
          label="Languages"
          value={brands.data === undefined ? '—' : languages.size}
          hint="used across the library"
          icon={<Icon name="fileText" />}
          tone="success"
        />
        <StatCard
          label="Voice ready"
          value={brands.data === undefined ? '—' : `${voiceReady}/${list.length}`}
          hint="brands with a tone set"
          icon={<Icon name="check" />}
          tone="success"
        />
      </div>

      <Card
        title="All brands"
        description="Open a brand to plan a campaign, review its posts or tune its voice."
      >
        {workspaces.isLoading && <Spinner label="Loading your workspace" />}

        {brands.isLoading && <Spinner label="Loading brands" />}

        {workspaces.isError && (
          <ErrorNotice
            message="Could not load your workspace."
            onRetry={() => void workspaces.refetch()}
          />
        )}

        {brands.isError && (
          <ErrorNotice message="Could not load brands." onRetry={() => void brands.refetch()} />
        )}

        {brands.data !== undefined && brands.data.length === 0 && (
          <EmptyState
            icon={<Icon name="brands" size={18} />}
            title="No brands yet"
            description="A brand carries the voice every post is written in."
            action={
              <Link href="/brands/new" className={`${styles.button} ${styles.primary}`}>
                Create your first brand
              </Link>
            }
          />
        )}

        {list.length > 0 && (
          <div className={styles.brandGrid}>
            {list.map((brand) => (
              <article key={brand.id} className={styles.brandCard}>
                <div className={styles.brandCardHead}>
                  <span className={styles.brandAvatar} aria-hidden="true">
                    {initialsOf(brand.name)}
                  </span>
                  <span>
                    <Link href={`/brands/${brand.id}`} className={styles.brandName}>
                      {brand.name}
                    </Link>
                    <span className={styles.brandIndustry}>
                      {brand.industry ?? 'No industry set'}
                    </span>
                  </span>
                </div>

                <div className={styles.brandTags}>
                  {brand.languages.slice(0, 3).map((language) => (
                    <span key={language} className={styles.tag}>
                      {language.toUpperCase()}
                    </span>
                  ))}
                  {brand.colors.slice(0, 3).map((color) => (
                    <span key={color} className={styles.tag}>
                      {color}
                    </span>
                  ))}
                </div>

                <div className={styles.brandFooter}>
                  <span>{brand.colors.length} colours</span>
                  <Link
                    href={`/brands/${brand.id}`}
                    className={styles.minorLink}
                    aria-label={`Open ${brand.name}`}
                  >
                    Open
                    <Icon name="arrowUpRight" size={12} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function initialsOf(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? 'B';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
