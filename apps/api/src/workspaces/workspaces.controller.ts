import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WORKSPACE_ROLES } from '@renderflow/common';
import { ValidationFailedError } from '@renderflow/common';
import { z } from 'zod';

import { CurrentUser } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { StudioService } from './studio.service';
import {
  createBrandSchema,
  createCampaignSchema,
  createPostSchema,
  updateBrandSchema,
  updatePostSchema,
} from './studio.service';
import { WorkspacesService } from './workspaces.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

const addMemberSchema = z.object({
  userId: z.uuid(),
  role: z.enum([...WORKSPACE_ROLES]),
});

/**
 * Workspace and studio endpoints.
 *
 * Every route takes the caller from the access token - never from the body or a
 * header - so a client cannot act as someone else by asking nicely. Workspace
 * scoping lives in `StudioService`, which resolves the owning workspace before
 * issuing a tenant-scoped query.
 */
@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: 'List the workspaces I belong to' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspaces.listMine(user.id);
  }

  @Get(':workspaceId')
  @ApiOperation({ summary: 'Fetch a workspace I am a member of' })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', uuidParam) workspaceId: string,
  ) {
    return this.workspaces.detail(workspaceId, user.id);
  }

  @Get(':workspaceId/members')
  @ApiOperation({ summary: 'List members (any member may read this)' })
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', uuidParam) workspaceId: string,
  ) {
    return this.workspaces.membersOf(workspaceId, user.id);
  }

  @Post(':workspaceId/members')
  @ApiOperation({ summary: 'Add or re-role a member (OWNER only)' })
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', uuidParam) workspaceId: string,
    @Body() body: unknown,
  ) {
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.workspaces.addMember(user.id, workspaceId, parsed.data.userId, parsed.data.role);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member (OWNER only; never the last owner)' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId', uuidParam) workspaceId: string,
    @Param('userId', uuidParam) userId: string,
  ): Promise<void> {
    return this.workspaces.removeMember(user.id, workspaceId, userId);
  }
}

/**
 * The studio surface.
 *
 * Split from `WorkspacesController` so `GET /workspaces` stays the one listing
 * endpoint and nothing under `/brands` or `/posts` can be reached without a
 * resource that has already been resolved against the caller's memberships.
 */
@ApiTags('studio')
@Controller()
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get('brands')
  @ApiOperation({ summary: 'List brands in a workspace' })
  listBrands(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspaceId', new ParseUUIDPipe({ version: '4' })) workspaceId: string,
  ) {
    return this.studio.listBrands(user.id, workspaceId);
  }

  @Post('brands')
  @ApiOperation({ summary: 'Create a brand (EDITOR+)' })
  async createBrand(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createBrandSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.studio.createBrand(user.id, parsed.data.workspaceId, parsed.data);
  }

  @Get('brands/:brandId')
  @ApiOperation({ summary: 'Fetch a brand' })
  getBrand(@CurrentUser() user: AuthenticatedUser, @Param('brandId', uuidParam) brandId: string) {
    return this.studio.getBrand(user.id, brandId);
  }

  @Patch('brands/:brandId')
  @ApiOperation({ summary: 'Update a brand (EDITOR+)' })
  async updateBrand(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandId', uuidParam) brandId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateBrandSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.studio.updateBrand(user.id, brandId, parsed.data);
  }

  @Delete('brands/:brandId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a brand (OWNER only)' })
  deleteBrand(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandId', uuidParam) brandId: string,
  ): Promise<void> {
    return this.studio.deleteBrand(user.id, brandId);
  }

  @Get('brands/:brandId/campaigns')
  @ApiOperation({ summary: 'List campaigns for a brand' })
  listCampaigns(
    @CurrentUser() user: AuthenticatedUser,
    @Param('brandId', uuidParam) brandId: string,
  ) {
    return this.studio.listCampaigns(user.id, brandId);
  }

  @Post('campaigns')
  @ApiOperation({ summary: 'Create a campaign (EDITOR+)' })
  async createCampaign(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createCampaignSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.studio.createCampaign(user.id, parsed.data);
  }

  @Get('campaigns/:campaignId/posts')
  @ApiOperation({ summary: 'List posts in a campaign' })
  listPosts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('campaignId', uuidParam) campaignId: string,
  ) {
    return this.studio.listPosts(user.id, campaignId);
  }

  @Post('posts')
  @ApiOperation({ summary: 'Create a post (EDITOR+)' })
  async createPost(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createPostSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.studio.createPost(user.id, parsed.data);
  }

  @Patch('posts/:postId')
  @ApiOperation({ summary: 'Edit a post; increments its version (EDITOR+)' })
  async updatePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('postId', uuidParam) postId: string,
    @Body() body: unknown,
  ) {
    const parsed = updatePostSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(formatIssues(parsed.error));
    }
    return this.studio.updatePost(user.id, postId, parsed.data);
  }

  @Post('posts/:postId/approve')
  @ApiOperation({ summary: 'Approve a post (APPROVER+)' })
  approvePost(@CurrentUser() user: AuthenticatedUser, @Param('postId', uuidParam) postId: string) {
    return this.studio.approvePost(user.id, postId);
  }

  @Get('posts/:postId/assets')
  @ApiOperation({ summary: "List a post's assets" })
  listAssets(@CurrentUser() user: AuthenticatedUser, @Param('postId', uuidParam) postId: string) {
    return this.studio.listAssets(user.id, postId);
  }
}

function formatIssues(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
    details[field] = [...(details[field] ?? []), issue.message];
  }
  return details;
}
