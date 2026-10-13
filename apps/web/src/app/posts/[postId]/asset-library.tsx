'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ApiClientError } from '@renderflow/api-client';

import { useApi } from '../../../lib/providers';
import { Badge, Button, Card, EmptyState, ErrorNotice, Spinner } from '../../../components/ui';
import styles from '../../../components/ui.module.css';

/**
 * The asset library for one post.
 *
 * Uploads go straight to object storage: the API issues a presigned URL, the
 * browser PUTs the bytes to it, and the browser then asks the API to CONFIRM by
 * reading the real object size back. The file never passes through the API,
 * which is what keeps a 200 MB reel from being buffered in a Node process.
 *
 * That flow has three failure modes this has to survive, none of them the
 * server's fault:
 *
 *  - the PUT is rejected because a required header was missing;
 *  - the PUT never lands (a closed laptop) and the row sits PENDING forever;
 *  - confirm rejects the file because its real size differs from what was
 *    declared. The server is right and the message has to say so, not "upload
 *    failed".
 */

/** Kept in step with the API's allow-list; a mismatch is a 400 with a clear body. */
const ACCEPT = 'image/png,image/jpeg,image/webp,video/mp4,audio/mpeg,application/pdf';

export function AssetLibrary({ postId, workspaceId }: { postId: string; workspaceId: string }) {
  const api = useApi();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);

  const [progress, setProgress] = useState<string | null>(null);

  const assets = useQuery({
    queryKey: ['assets', postId],
    queryFn: () => api.posts.assets(postId),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // The size is DECLARED here and verified by the server on confirm. It is
      // not trusted on this side, but sending it lets the API refuse an
      // oversized file before a URL is ever issued.
      const presigned = await api.assets.requestUpload({
        workspaceId,
        mime: file.type,
        sizeBytes: file.size,
        postId,
      });

      setProgress(`Uploading ${file.name}…`);

      const response = await fetch(presigned.upload.url, {
        method: presigned.upload.method,
        // The declared Content-Type has to match what S3 signed for, or the PUT
        // is rejected with a signature mismatch that explains nothing.
        headers: { 'Content-Type': file.type, ...presigned.upload.headers },
        body: file,
      });

      if (!response.ok) {
        throw new Error(`storage rejected the upload (${response.status})`);
      }

      setProgress('Confirming…');
      await api.assets.confirm(presigned.asset.id);

      return presigned.asset;
    },
    retry: false,
    onSettled: () => setProgress(null),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['assets', postId] }),
  });

  function onPick(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];

    // Cleared so choosing the SAME file twice fires `change` again; otherwise a
    // user who picks a file, watches it fail, and picks it again sees nothing
    // happen.
    event.target.value = '';

    if (file !== undefined) {
      upload.mutate(file);
    }
  }

  return (
    <Card
      title="Assets"
      description="Generated media and anything you upload for this post."
      actions={
        <>
          <input
            ref={input}
            id="asset-upload"
            type="file"
            accept={ACCEPT}
            className="sr-only"
            // A real accessible name, even though the input is visually hidden
            // behind a button. Without one it is announced as "file" with no
            // indication of what choosing a file does, and a screen-reader user
            // reaches a control they cannot identify.
            aria-label="Choose a file to upload"
            onChange={onPick}
            disabled={upload.isPending}
          />
          <Button
            variant="secondary"
            busy={upload.isPending}
            onClick={() => input.current?.click()}
          >
            Upload
          </Button>
        </>
      }
    >
      {/*
        The file input is visually hidden rather than `display: none`, so it stays
        focusable and keyboard-reachable; the visible button is what a mouse
        clicks. `sr-only` is what keeps both paths working.
      */}

      {progress !== null && (
        <p className={styles.loading} role="status">
          {progress}
        </p>
      )}

      {upload.isError && <ErrorNotice message={uploadMessage(upload.error)} />}

      {assets.isLoading && <Spinner label="Loading assets" />}

      {assets.isError && (
        <ErrorNotice message="Could not load assets." onRetry={() => void assets.refetch()} />
      )}

      {assets.data !== undefined && assets.data.length === 0 && (
        <EmptyState
          title="No assets yet"
          description="Generate a poster or reel, or upload an image to publish."
        />
      )}

      {assets.data !== undefined && assets.data.length > 0 && (
        <ul className={styles.list}>
          {(assets.data as AssetRow[]).map((asset) => (
            <li key={asset.id} className={styles.listItem}>
              <span>
                <AssetLabel asset={asset} />
                <span className={styles.cardDescription}>
                  {' '}
                  {asset.mime} · {formatBytes(asset.sizeBytes)}
                </span>
              </span>
              <Badge tone={asset.meta?.status === 'READY' ? 'good' : 'warn'}>
                {asset.meta?.status ?? 'unknown'}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The filename, or the type when there is none - a storage key is not a name. */
function AssetLabel({ asset }: { asset: AssetRow }) {
  const key = asset.storageKey;
  const last = key.split('/').pop();

  return <span>{last ?? asset.type}</span>;
}

/**
 * Says what to do, not what happened.
 *
 * The confirm step rejecting a file is the one a user needs to understand: the
 * declared size did not match the real one, and re-uploading the right file is
 * the fix.
 */
function uploadMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'UNSUPPORTED_MEDIA_TYPE') {
    return 'That file type is not supported.';
  }

  if (error instanceof ApiClientError && error.code === 'PAYLOAD_TOO_LARGE') {
    return 'That file is too large.';
  }

  if (error instanceof ApiClientError && error.status === 422) {
    return error.message;
  }

  if (error instanceof Error && error.message.includes('storage rejected')) {
    return 'The upload was rejected by storage. Try again - nothing was saved.';
  }

  if (error instanceof Error && error.message.includes('failed to fetch')) {
    return 'The upload did not reach storage. Check your connection and try again.';
  }

  return 'The upload did not complete. Nothing was saved.';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AssetRow {
  id: string;
  storageKey: string;
  mime: string;
  sizeBytes: number;
  type: string;
  meta?: { status?: string } | null;
}
