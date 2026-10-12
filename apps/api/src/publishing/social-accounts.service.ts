import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@renderflow/common';
import { getDb, socialAccounts, workspaces, type SocialAccount } from '@renderflow/db';
import { tokenCipherFromEnv, type SocialPlatform, type TokenCipher } from '@renderflow/social';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

/**
 * Connecting social accounts (Phase 7: "OAuth connect, token encryption/
 * refresh"; AGENTS.md section 10: "Encrypt social tokens at rest ... Never return
 * tokens from the API").
 *
 * The token NEVER leaves this module. `toView` is the only shape that reaches a
 * controller, and it has no field for it - not a masked one, none. A masked
 * token still tells an attacker the prefix and length, and the only thing that
 * should ever be readable from outside is "is this account connected".
 *
 * The key is resolved at call time rather than at construction; see the note on
 * `cipher()` for why, and why the publisher worker disagrees.
 */

export const connectAccountSchema = z.object({
  workspaceId: z.uuid(),
  platform: z.enum(['linkedin', 'instagram']),
  externalAccountId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(200).optional(),
  /** The access token to store, encrypted. Never returned. */
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1).optional(),
  /** ISO instant; absent means "never expires", which is how mocks connect. */
  tokenExpiresAt: z.iso.datetime().optional(),
  scopes: z.array(z.string().max(100)).max(50).default([]),
});

export interface SocialAccountView {
  id: string;
  workspaceId: string;
  platform: SocialPlatform;
  externalAccountId: string;
  displayName: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  connectedBy: string;
  createdAt: string;
  /**
   * True when the token has expired. Not the token's fault - the platform's -
   * and it is what tells the UI to prompt for a reconnect instead of letting a
   * user watch a scheduled post fail.
   */
  needsReconnect: boolean;
}

@Injectable()
export class SocialAccountsService implements OnModuleInit {
  private db!: ReturnType<typeof getDb>;

  /**
   * Resolved LAZILY, per call.
   *
   * The obvious alternative is a field initialiser, which fails at construction
   * - and that takes down every other route with it. A developer without social
   * accounts configured, or a deployment that has not enabled publishing yet,
   * would find that auth, credits and `/admin/reconcile` all refuse to boot
   * because one optional feature is unconfigured. Failing the whole process for
   * a feature nobody is using is its own kind of outage.
   *
   * The publisher worker takes the opposite position, and asserts at boot: it
   * exists ONLY to publish, so a worker that accepts jobs it cannot decrypt is
   * worse than one that does not start. See `apps/publisher-worker`.
   *
   * A failure still surfaces with the variable name, so it is a five-second fix
   * rather than a mystery 500.
   */
  private cipher(): TokenCipher {
    return tokenCipherFromEnv();
  }

  constructor(private readonly access: WorkspaceAccessService) {}

  onModuleInit(): void {
    this.db = getDb();
  }

  /**
   * Records a connected account, or rotates the token on an existing one.
   *
   * An UPSERT rather than an insert: reconnecting the same account must not
   * leave two rows, because publish would then pick between them at random and
   * half the posts would go out under a revoked token.
   *
   * The access and refresh tokens are encrypted as ONE blob under a single
   * envelope. Encrypting them separately would let a partial write pair a new
   * access token with an old refresh token - which is exactly the combination
   * every platform rejects, with a message that does not say why.
   */
  async connect(
    userId: string,
    // `z.input`, not `z.infer`: `scopes` has a default, so the OUTPUT type
    // requires it while every caller reasonably omits it. Typing the parameter
    // as the output would push default-filling onto every call site.
    input: z.input<typeof connectAccountSchema>,
  ): Promise<SocialAccountView> {
    await this.access.scope({
      userId,
      resource: 'workspace',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId))
          .limit(1);

        return rows[0] === undefined ? null : { workspaceId: rows[0].id, value: rows[0] };
      },
    });

    const payload = this.cipher().encrypt(
      JSON.stringify({
        accessToken: input.accessToken,
        // An empty refresh token is not the same as no refresh token: the first
        // means "this platform issued none", the second means "the caller did
        // not say", and only one of them can be acted on later.
        refreshToken: input.refreshToken ?? null,
      }),
    );

    const [row] = await this.db
      .insert(socialAccounts)
      .values({
        workspaceId: input.workspaceId,
        platform: input.platform,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName ?? null,
        token: payload,
        tokenExpiresAt: input.tokenExpiresAt === undefined ? null : new Date(input.tokenExpiresAt),
        scopes: input.scopes,
        connectedBy: userId,
      })
      .onConflictDoUpdate({
        // The unique index is on (workspace, platform, external_account_id), so
        // this targets exactly the row being reconnected.
        target: [
          socialAccounts.workspaceId,
          socialAccounts.platform,
          socialAccounts.externalAccountId,
        ],
        set: {
          token: payload,
          displayName: input.displayName ?? null,
          tokenExpiresAt:
            input.tokenExpiresAt === undefined ? null : new Date(input.tokenExpiresAt),
          scopes: input.scopes,
          connectedBy: userId,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (row === undefined) {
      throw new AppError(ERROR_CODES.CONFLICT, 'the account could not be connected');
    }

    return toView(row);
  }

  /** The accounts a workspace publishes to. No token, ever. */
  async list(userId: string, workspaceId: string): Promise<SocialAccountView[]> {
    await this.access.scope({
      userId,
      resource: 'workspace',
      lookup: async (db) => {
        const rows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);

        return rows[0] === undefined ? null : { workspaceId: rows[0].id, value: rows[0] };
      },
    });

    const rows = await this.db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.workspaceId, workspaceId))
      .orderBy(socialAccounts.createdAt);

    return rows.map(toView);
  }

  /**
   * Disconnects an account.
   *
   * Refuses while live publish jobs still reference it. Deleting the row would
   * cascade-delete the jobs with it, so a post scheduled for an hour from now
   * would vanish from the user's calendar instead of failing visibly.
   */
  async disconnect(userId: string, accountId: string): Promise<{ disconnected: boolean }> {
    const scoped = await this.access.scope({
      userId,
      resource: 'socialAccount',
      required: 'EDITOR',
      lookup: async (db) => {
        const rows = await db
          .select()
          .from(socialAccounts)
          .where(eq(socialAccounts.id, accountId))
          .limit(1);

        const row = rows[0];
        return row === undefined ? null : { workspaceId: row.workspaceId, value: row };
      },
    });

    const pending = await this.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n
        FROM publish_jobs
       WHERE social_account_id = ${scoped.value.id}
         AND status IN ('PENDING','SCHEDULED','PUBLISHING')
    `);

    if (Number(pending.rows[0]?.n ?? '0') > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'this account has posts still scheduled; cancel them first',
      );
    }

    await this.db
      .delete(socialAccounts)
      .where(
        and(
          eq(socialAccounts.id, scoped.value.id),
          eq(socialAccounts.workspaceId, scoped.workspaceId),
        ),
      );

    return { disconnected: true };
  }
}

function toView(row: SocialAccount): SocialAccountView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    platform: row.platform,
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    scopes: row.scopes,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    connectedBy: row.connectedBy,
    createdAt: row.createdAt.toISOString(),
    needsReconnect: row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= Date.now(),
  };
}
