import { PostEditor } from './post-editor';

export default async function PostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;

  return <PostEditor postId={postId} />;
}
