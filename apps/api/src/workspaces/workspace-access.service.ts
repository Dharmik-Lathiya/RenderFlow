import { Injectable } from '@nestjs/common';
import { WorkspaceAccessDeniedError } from '@renderflow/common';
import type { WorkspaceRole } from '@renderflow/common';
import { getDb, type Database } from '@renderflow/db';

import { WorkspacesService } from './workspaces.service';

/**
 * Why tenancy is enforced here and not in a guard.
 *
 * AGENTS.md section 10 says to use guards for RBAC, and Phase 1 does: the
 * workspace-aware guard resolves `:workspaceId` from the route. Phase 3 cannot use
 * that shape, because the documented API addresses resources directly
 * (`POST /brands`, `GET /brands/:id`) rather than nesting them under a workspace.
 * A guard cannot know which workspace `/brands/:brandId` belongs to without
 * fetching the brand - which is the query the service runs anyway.
 *
 * So the rule is enforced here, after the resource's workspace is known and
 * before the caller's access is checked. That puts membership verification on the
 * single path that issues the tenant-scoped query, which is what actually
 * prevents a leak. A guard that only checked a route param would have been
 * decorative.
 *
 * Every scoped service method funnels through `scope()`, so there is one
 * implementation of the rule rather than one per endpoint.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly workspaces: WorkspacesService) {}

  /**
   * Resolves the workspace that owns a resource and verifies the caller may act
   * on it.
   *
   * `lookup` returns the owning workspace id for the resource. It runs BEFORE the
   * access check on purpose: the caller must not learn whether a foreign id
   * exists, so "not yours" and "does not exist" must produce the same answer.
   */
  async scope<T>(args: {
    userId: string;
    resource: 'workspace' | 'brand' | 'campaign' | 'post' | 'asset' | 'job';
    lookup: (db: Database) => Promise<{ workspaceId: string; value: T } | null>;
    required?: WorkspaceRole;
  }): Promise<{ workspaceId: string; role: WorkspaceRole; value: T }> {
    const db = getDb();
    const found = await args.lookup(db);

    if (found === null) {
      // Deliberately no id: the caller learns nothing about whether a foreign
      // resource exists, which is the whole point of running the lookup first.
      throw new WorkspaceAccessDeniedError('', args.resource);
    }

    let membership: { role: WorkspaceRole };

    try {
      membership = await this.workspaces.requireMembership(
        db,
        found.workspaceId,
        args.userId,
        args.required,
      );
    } catch (error) {
      // `requireMembership` names the workspace it refused, which is right for
      // the workspace-addressed routes (`/workspaces/:id` - the caller already
      // had the id) and wrong here. A resource-addressed caller never knew the
      // workspace id, so echoing it back confirms that the resource exists and
      // hands them the next thing to try. Re-thrown with the resource type only.
      if (error instanceof WorkspaceAccessDeniedError) {
        throw new WorkspaceAccessDeniedError('', args.resource);
      }
      throw error;
    }

    return { workspaceId: found.workspaceId, role: membership.role, value: found.value };
  }
}

/** Re-exported so services can spell the role argument without a second import. */
export type { WorkspaceRole as WorkspaceRoleFloor } from '@renderflow/common';
