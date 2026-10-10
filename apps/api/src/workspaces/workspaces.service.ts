import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  AppError,
  ERROR_CODES,
  WORKSPACE_ROLES,
  WorkspaceAccessDeniedError,
} from '@renderflow/common';
import type { WorkspaceRole } from '@renderflow/common';
import {
  getDb,
  users,
  workspaceMembers,
  workspaces,
  type Database,
  type DbTransaction,
} from '@renderflow/db';

/**
 * Workspace membership: the multi-tenant isolation boundary.
 *
 * AGENTS.md section 10 requires every workspace-scoped query to filter by the
 * caller's membership, with a test per endpoint. This module is the only place
 * that answers "may this user touch that workspace, and as what", so an endpoint
 * cannot invent its own rule and get it subtly wrong.
 *
 * Two failure modes are deliberately distinguishable, because they are different
 * bugs:
 *
 *   - not a member at all -> 403 WORKSPACE_ACCESS_DENIED. Deliberate: returning
 *     404 would leak the existence of another tenant's workspace to someone
 *     probing ids.
 *   - a member, but the role is too low -> 403 INSUFFICIENT_ROLE, with the
 *     required and actual roles in `details` so the client can hide the control
 *     instead of showing an error the user cannot act on.
 */

export interface Membership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/**
 * Raised when a member's role is too low for the operation.
 *
 * An `AppError` rather than a bare Error so the global exception filter renders
 * it as the documented `{ code, message, details }` body with `403` and
 * `INSUFFICIENT_ROLE` - the code clients are expected to branch on when hiding
 * controls the user cannot use.
 */
export class InsufficientWorkspaceRoleError extends AppError {
  constructor(required: readonly WorkspaceRole[], actual: WorkspaceRole) {
    super(ERROR_CODES.INSUFFICIENT_ROLE, undefined, {
      details: { required: [...required], actual },
    });
  }
}

/**
 * What each workspace role may do.
 *
 * Deliberately NOT a linear rank. A rank of OWNER > EDITOR > APPROVER > VIEWER
 * implies an editor can approve, and that is exactly the thing the role split
 * exists to prevent: a person who wrote the caption should not be the one who
 * signs it off. So the capabilities are enumerated and the two that matter -
 * write and approve - are disjoint below OWNER.
 *
 *   capability  VIEWER  EDITOR  APPROVER  OWNER
 *   read           yes     yes      yes      yes
 *   write          no      yes      no       yes
 *   approve        no      no       yes      yes
 *   administer     no      no       no       yes
 */
const ROLE_CAPABILITIES: Readonly<
  Record<WorkspaceRole, readonly ('read' | 'write' | 'approve' | 'administer')[]>
> = {
  VIEWER: ['read'],
  EDITOR: ['read', 'write'],
  APPROVER: ['read', 'approve'],
  OWNER: ['read', 'write', 'approve', 'administer'],
};

export type WorkspaceCapability = 'read' | 'write' | 'approve' | 'administer';

export function roleHas(actual: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return ROLE_CAPABILITIES[actual].includes(capability);
}

/**
 * True when `actual` holds `required`, expressed as capability membership.
 *
 * The unit tests pin each combination, because getting this wrong is silent: the
 * API simply lets the wrong people edit or approve.
 */
export function roleSatisfies(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  // Holding a role is always enough to hold it.
  if (actual === required) {
    return true;
  }
  return roleHas(actual, capabilityForRole(required));
}

function capabilityForRole(role: WorkspaceRole): WorkspaceCapability {
  switch (role) {
    case 'OWNER':
      return 'administer';
    case 'EDITOR':
      return 'write';
    case 'APPROVER':
      return 'approve';
    case 'VIEWER':
      return 'read';
  }
}

@Injectable()
export class WorkspacesService implements OnModuleInit {
  private db!: Database;

  onModuleInit(): void {
    this.db = getDb();
  }

  /** The role a user holds in a workspace, or null if they are not a member. */
  async membershipOf(
    db: Database | DbTransaction,
    workspaceId: string,
    userId: string,
  ): Promise<Membership | null> {
    const rows = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return { workspaceId: row.workspaceId, userId: row.userId, role: row.role };
  }

  /**
   * Resolves a membership or throws.
   *
   * Every workspace-scoped endpoint calls this before touching data, so a
   * missing membership can never reach a query that would leak another tenant's
   * rows.
   */
  async requireMembership(
    db: Database | DbTransaction,
    workspaceId: string,
    userId: string,
    required?: WorkspaceRole,
  ): Promise<Membership> {
    const membership = await this.membershipOf(db, workspaceId, userId);

    if (membership === null) {
      throw new WorkspaceAccessDeniedError(workspaceId);
    }

    if (required !== undefined && !roleSatisfies(membership.role, required)) {
      throw new InsufficientWorkspaceRoleError([required], membership.role);
    }

    return membership;
  }

  /**
   * Every workspace a user belongs to.
   *
   * `IS DISTINCT FROM` is not needed here, but the join is explicit rather than
   * filtering in application code, so a workspace deleted underneath a member
   * cannot produce a phantom entry.
   */
  async listForUser(
    db: Database | DbTransaction,
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: WorkspaceRole; createdAt: Date }>> {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        createdAt: workspaces.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(workspaces.createdAt);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      createdAt: row.createdAt,
    }));
  }

  async get(
    db: Database | DbTransaction,
    workspaceId: string,
  ): Promise<{ id: string; name: string; ownerId: string; createdAt: Date }> {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new WorkspaceAccessDeniedError(workspaceId);
    }
    return row;
  }

  /**
   * Lists the members of a workspace.
   *
   * Callers must already have resolved membership; this method intentionally
   * does not check, so it can be reused by admin tooling and the seed path
   * without every caller repeating the guard.
   */
  async listMembers(
    db: Database | DbTransaction,
    workspaceId: string,
  ): Promise<Array<{ userId: string; role: WorkspaceRole; createdAt: Date }>> {
    const rows = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        createdAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(workspaceMembers.createdAt);

    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt,
    }));
  }

  /** Adds or changes a member's role. The composite PK makes this an upsert. */
  async setMemberRole(
    db: Database | DbTransaction,
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    await db
      .insert(workspaceMembers)
      .values({ workspaceId, userId, role })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role },
      });
  }

  /**
   * Counts members by role. Used by the owner-transfer guard.
   */
  async countOwners(db: Database | DbTransaction, workspaceId: string): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'OWNER')),
      );

    return rows[0]?.count ?? 0;
  }

  // --- API-facing operations -----------------------------------------------

  /** The workspaces I belong to. There is deliberately no "all workspaces". */
  async listMine(
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: WorkspaceRole }>> {
    const rows = await this.listForUser(this.db, userId);
    return rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
  }

  async create(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string; role: WorkspaceRole }> {
    // Workspace and OWNER membership in one transaction: a workspace with no
    // owner is invisible to every member and cannot be recovered.
    return this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name, ownerId: userId })
        .returning({ id: workspaces.id, name: workspaces.name });

      if (workspace === undefined) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Workspace insert returned no row');
      }

      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId, role: 'OWNER' });

      return { ...workspace, role: 'OWNER' as const };
    });
  }

  /** Adds or re-roles a member. OWNER only: membership is the grant that grants. */
  async addMember(
    actorUserId: string,
    workspaceId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ): Promise<{ userId: string; role: WorkspaceRole }> {
    await this.requireMembership(this.db, workspaceId, actorUserId, 'OWNER');

    // The FK would reject an unknown user, but with an opaque constraint
    // violation instead of a 404 the caller can act on.
    const exists = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (exists.length === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', {
        details: { userId: targetUserId },
      });
    }

    await this.setMemberRole(this.db, workspaceId, targetUserId, role);
    return { userId: targetUserId, role };
  }

  async removeMember(
    actorUserId: string,
    workspaceId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.requireMembership(this.db, workspaceId, actorUserId, 'OWNER');

    const target = await this.membershipOf(this.db, workspaceId, targetUserId);
    if (target === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Not a member of this workspace');
    }

    // A workspace with no owner is unmanageable, and no member could restore one.
    if (target.role === 'OWNER' && (await this.countOwners(this.db, workspaceId)) <= 1) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Cannot remove the last owner of a workspace');
    }

    await this.removeMemberRow(this.db, workspaceId, targetUserId);
  }

  private async removeMemberRow(
    db: Database | DbTransaction,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      );
  }

  async membersOf(
    workspaceId: string,
    callerUserId: string,
  ): Promise<Array<{ userId: string; role: WorkspaceRole }>> {
    await this.requireMembership(this.db, workspaceId, callerUserId);
    const rows = await this.listMembers(this.db, workspaceId);
    return rows.map((row) => ({ userId: row.userId, role: row.role }));
  }

  async detail(
    workspaceId: string,
    callerUserId: string,
  ): Promise<{ id: string; name: string; ownerId: string; role: WorkspaceRole }> {
    const membership = await this.requireMembership(this.db, workspaceId, callerUserId);
    const workspace = await this.get(this.db, workspaceId);
    return { ...workspace, role: membership.role };
  }
}

export { WORKSPACE_ROLES };
