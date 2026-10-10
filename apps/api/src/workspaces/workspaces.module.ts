import { Global, Module } from '@nestjs/common';

import { StudioController, WorkspacesController } from './workspaces.controller';
import { StudioService } from './studio.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesService } from './workspaces.service';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';

/**
 * Workspaces, brands, campaigns, posts and assets.
 *
 * `@Global` so `StudioService` and `WorkspacesService` can be injected by later
 * modules (the job pipeline in Phase 4 will resolve a post's workspace the same
 * way) without every one of them importing this module.
 */
@Global()
@Module({
  controllers: [WorkspacesController, StudioController, AssetsController],
  providers: [WorkspacesService, WorkspaceAccessService, StudioService, AssetsService],
  exports: [WorkspacesService, WorkspaceAccessService, StudioService, AssetsService],
})
export class WorkspacesModule {}
