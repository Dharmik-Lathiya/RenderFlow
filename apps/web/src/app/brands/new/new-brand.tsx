'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { useApi } from '../../../lib/providers';
import { Button, Card, EmptyState, ErrorNotice, Field, Spinner } from '../../../components/ui';
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

  return (
    <div className={styles.authCard}>
      <Card title="New brand" description="A brand carries the voice every post is written in.">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);

            if (name.trim() === '' || workspaces.data?.[0] === undefined) {
              return;
            }

            create.mutate();
          }}
          noValidate
        >
          {create.isError && <ErrorNotice message="Could not create the brand." />}

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
            Create brand
          </Button>
        </form>
      </Card>
    </div>
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

  return (
    <>
      <h1>Brands</h1>

      <Card
        title="All brands"
        actions={
          <Link href="/brands/new">
            <Button variant="primary">New brand</Button>
          </Link>
        }
      >
        {(workspaces.isLoading || brands.isLoading) && <Spinner label="Loading brands" />}

        {brands.isError && (
          <ErrorNotice message="Could not load brands." onRetry={() => void brands.refetch()} />
        )}

        {brands.data !== undefined && brands.data.length === 0 && (
          <EmptyState
            title="No brands yet"
            description="A brand carries the voice every post is written in."
            action={
              <Link href="/brands/new">
                <Button variant="primary">Create your first brand</Button>
              </Link>
            }
          />
        )}

        {brands.data !== undefined && brands.data.length > 0 && (
          <ul className={styles.list}>
            {brands.data.map((brand) => (
              <li key={brand.id} className={styles.listItem}>
                <Link href={`/brands/${brand.id}`}>{brand.name}</Link>
                {brand.industry !== null && (
                  <span className={styles.cardDescription}>{brand.industry}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
