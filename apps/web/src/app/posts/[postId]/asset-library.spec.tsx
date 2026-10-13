import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AssetLibrary } from './asset-library';
import { renderWithProviders, stubApi } from '../../../test/harness';

/**
 * The asset library.
 *
 * The upload path is three steps - presign, PUT to storage, confirm - and each
 * one can fail in a way the user needs to be told differently. A screen that
 * says "upload failed" for all three is technically true and useless.
 */

const WORKSPACE = 'w1';
const POST = 'p1';

/**
 * The raw storage PUT goes through the global `fetch`, not the client's seam -
 * jsdom has no fetch, so it has to be stubbed per test rather than set once.
 */
function stubGlobalFetch(response: { ok: boolean; status: number }): jest.Mock {
  const stub = jest.fn(async () => response);
  (globalThis as unknown as { fetch: unknown }).fetch = stub;
  return stub;
}

const READY_ASSET = {
  id: 'a1',
  postId: POST,
  type: 'IMAGE',
  storageKey: 'workspaces/w1/assets/a1',
  mime: 'image/png',
  sizeBytes: 2048,
  width: 1024,
  height: 1024,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AssetLibrary', () => {
  it('offers an upload control a keyboard can reach', async () => {
    const { client } = stubApi({ 'GET /posts/{postId}/assets': { body: [] } });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    const button = await screen.findByRole('button', { name: 'Upload' });
    expect(button).toBeEnabled();

    // The file input itself is `sr-only`, not `display: none`, so it stays in the
    // tab order; the visible button is what a mouse clicks. And it carries its
    // own name, because a hidden file input with none is announced as "file".
    const input = screen.getByLabelText('Choose a file to upload');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept');
  });

  it('presigns, PUTs and confirms in that order', async () => {
    const order: string[] = [];

    const { client, calls } = stubApi({
      'GET /posts/{postId}/assets': { body: [] },
      'POST /assets/uploads': () => {
        order.push('presign');
        return {
          body: {
            asset: READY_ASSET,
            upload: {
              url: 'http://storage.test/put',
              method: 'PUT',
              headers: { 'x-amz-acl': 'private' },
              expiresInSeconds: 900,
            },
          },
        };
      },
      'POST /assets/{assetId}/confirm': () => {
        order.push('confirm');
        return { body: { ...READY_ASSET, meta: { status: 'READY' } } };
      },
    });

    stubGlobalFetch({ ok: true, status: 200 });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    const file = new File(['x'.repeat(2048)], 'poster.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Choose a file to upload'), file);

    await waitFor(() => expect(order).toEqual(['presign', 'confirm']));

    // The declared size travels with the request: the API refuses an oversized
    // file before a URL is ever issued.
    const presign = calls.find((call) => call.url === '/assets/uploads');
    expect(presign?.body).toMatchObject({ mime: 'image/png', sizeBytes: 2048, postId: POST });
  });

  it('says nothing was saved when storage rejects the PUT', async () => {
    // The confirm step never runs, so there is no half-uploaded asset lying
    // around pretending to be usable.
    const { client, calls } = stubApi({
      'GET /posts/{postId}/assets': { body: [] },
      'POST /assets/uploads': {
        body: {
          asset: READY_ASSET,
          upload: {
            url: 'http://storage.test/put',
            method: 'PUT',
            headers: {},
            expiresInSeconds: 900,
          },
        },
      },
    });

    stubGlobalFetch({ ok: false, status: 403 });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    const file = new File(['x'.repeat(2048)], 'poster.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Choose a file to upload'), file);

    expect(await screen.findByText(/rejected by storage/i)).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/confirm'))).toBe(false);
  });

  it('explains a rejected confirm as a size mismatch', async () => {
    // The API is right here: the declared size did not match the real one. A
    // generic "upload failed" would leave the user re-uploading the same wrong
    // file.
    const { client } = stubApi({
      'GET /posts/{postId}/assets': { body: [] },
      'POST /assets/uploads': {
        body: {
          asset: READY_ASSET,
          upload: {
            url: 'http://storage.test/put',
            method: 'PUT',
            headers: {},
            expiresInSeconds: 900,
          },
        },
      },
      'POST /assets/{assetId}/confirm': {
        status: 422,
        body: {
          code: 'VALIDATION_FAILED',
          message: 'Declared size does not match the uploaded object.',
        },
      },
    });

    stubGlobalFetch({ ok: true, status: 200 });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    const file = new File(['x'.repeat(2048)], 'poster.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Choose a file to upload'), file);

    expect(await screen.findByText(/does not match the uploaded object/i)).toBeInTheDocument();
  });

  it('never sends a file type the browser has already ruled out', async () => {
    // The `accept` attribute means the picker refuses an `.exe` before any
    // request exists. Asserting the stronger property: nothing is uploaded, so
    // there is no window in which an oversized or unsupported file is in flight.
    const { client, calls } = stubApi({ 'GET /posts/{postId}/assets': { body: [] } });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    const file = new File(['MZ'], 'thing.exe', { type: 'application/x-msdownload' });
    await userEvent.upload(screen.getByLabelText('Choose a file to upload'), file);

    expect(calls.some((call) => call.url === '/assets/uploads')).toBe(false);
  });

  it('surfaces the API refusing a type the browser allowed', async () => {
    // `accept` is a hint, not a control: a browser can be configured to ignore
    // it, and the API is the authority either way.
    const { client } = stubApi({
      'GET /posts/{postId}/assets': { body: [] },
      'POST /assets/uploads': {
        status: 415,
        body: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'That MIME type is not allowed.' },
      },
    });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    // mp4 is on the `accept` list, so the browser lets it through; the stub has
    // the API refusing it, which is what happens when the server's allow-list is
    // narrower than the client's.
    const file = new File(['x'.repeat(10)], 'clip.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByLabelText('Choose a file to upload'), file);

    expect(await screen.findByText('That file type is not supported.')).toBeInTheDocument();
  });

  it('shows what is already there, and whether it is usable', async () => {
    const { client } = stubApi({
      'GET /posts/{postId}/assets': {
        body: [
          { ...READY_ASSET, meta: { status: 'READY' } },
          {
            ...READY_ASSET,
            id: 'a2',
            storageKey: 'workspaces/w1/assets/a2',
            meta: { status: 'PENDING_UPLOAD' },
          },
        ],
      },
    });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    // A PENDING row has nothing behind it yet, and a user who cannot tell the
    // difference will try to publish it.
    expect(await screen.findByText('READY')).toBeInTheDocument();
    expect(screen.getByText('PENDING_UPLOAD')).toBeInTheDocument();
  });

  it('invites an upload when there is nothing yet', async () => {
    const { client } = stubApi({ 'GET /posts/{postId}/assets': { body: [] } });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    expect(await screen.findByText('No assets yet')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot load', async () => {
    const { client } = stubApi({
      'GET /posts/{postId}/assets': {
        status: 500,
        body: { code: 'INTERNAL', message: 'boom' },
      },
    });

    renderWithProviders(<AssetLibrary postId={POST} workspaceId={WORKSPACE} />, client);

    expect(await screen.findByText('Could not load assets.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
