import { workspaces, workspaceMembers, brands, campaigns, posts } from '@renderflow/db';

import type { TestDb } from './test-database';

/**
 * Studio fixtures: workspace -> brand -> campaign -> post.
 *
 * Shared because four suites now need the same four rows, and four hand-rolled
 * versions of them drift - one creates a workspace without the OWNER membership
 * row (which `membershipOf` only ever reads from `workspace_members`, so the
 * fixture looks like an access bug), and another forgets the campaigns'
 * `createdBy`, which is not nullable.
 */

export interface StudioFixture {
  workspaceId: string;
  brandId: string;
  campaignId: string;
  postId: string;
}

export async function seedWorkspaceFor(
  db: TestDb,
  userId: string,
  name = 'Acme',
): Promise<{ workspaceId: string }> {
  const [workspace] = await db
    .insert(workspaces)
    .values({ name, ownerId: userId })
    .returning({ id: workspaces.id });

  if (workspace === undefined) {
    throw new Error('workspace insert returned nothing');
  }

  // The owner's membership is a ROW, not a shortcut on `workspaces.owner_id`.
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId, role: 'OWNER' });

  return { workspaceId: workspace.id };
}

export async function seedBrandCampaignPost(
  db: TestDb,
  input: { workspaceId: string; userId: string; postStatus?: string },
): Promise<StudioFixture> {
  const [brand] = await db
    .insert(brands)
    .values({
      workspaceId: input.workspaceId,
      name: 'Acme',
      industry: 'retail',
      colors: [],
      languages: ['en'],
    })
    .returning({ id: brands.id });

  if (brand === undefined) {
    throw new Error('brand insert returned nothing');
  }

  const [campaign] = await db
    .insert(campaigns)
    .values({
      brandId: brand.id,
      goal: 'launch',
      status: 'ACTIVE',
      createdBy: input.userId,
    })
    .returning({ id: campaigns.id });

  if (campaign === undefined) {
    throw new Error('campaign insert returned nothing');
  }

  const [post] = await db
    .insert(posts)
    .values({
      campaignId: campaign.id,
      brandId: brand.id,
      type: 'CAPTION',
      caption: 'Rain again.',
      hashtags: '#weather',
      status: (input.postStatus ?? 'APPROVED') as 'APPROVED',
    })
    .returning({ id: posts.id });

  if (post === undefined) {
    throw new Error('post insert returned nothing');
  }

  return {
    workspaceId: input.workspaceId,
    brandId: brand.id,
    campaignId: campaign.id,
    postId: post.id,
  };
}
