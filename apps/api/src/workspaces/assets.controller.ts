import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationFailedError } from '@renderflow/common';

import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { AssetsService } from './assets.service';
import { StudioService, requestUploadSchema } from './studio.service';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/**
 * Asset upload and download.
 *
 * A three-step flow, because the bytes go straight to object storage:
 *
 *   POST   /assets/uploads    -> asset row + presigned PUT URL
 *   (client PUTs the bytes directly to S3)
 *   POST   /assets/:id/confirm -> server reads the real size back and marks it ready
 *   GET    /assets/:id/download -> short-lived presigned GET
 *
 * `confirm` is not optional bookkeeping. `requestUpload` can only check the size
 * the client *claimed*, so this is where the actual object is measured.
 */
@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly studio: StudioService,
  ) {}

  @Post('uploads')
  @ApiOperation({ summary: 'Create an asset record and get a presigned upload URL' })
  async requestUpload(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = requestUploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationFailedError(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.length > 0 ? issue.path.join('.') : '(body)',
            issue.message,
          ]),
        ),
      );
    }
    return this.assets.requestUpload(user.id, this.studio, parsed.data);
  }

  @Post(':assetId/confirm')
  @ApiOperation({ summary: 'Confirm an upload by reading the real object size back' })
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('assetId', uuidParam) assetId: string) {
    return this.assets.confirm(user.id, this.studio, assetId);
  }

  @Get(':assetId/download')
  @ApiOperation({ summary: 'Get a short-lived presigned download URL' })
  download(@CurrentUser() user: AuthenticatedUser, @Param('assetId', uuidParam) assetId: string) {
    return this.assets.downloadUrl(user.id, this.studio, assetId);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an asset' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetId', uuidParam) assetId: string,
  ): Promise<void> {
    return this.assets.remove(user.id, assetId);
  }
}
