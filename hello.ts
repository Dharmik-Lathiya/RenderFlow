export default async function hello(request: Request): Promise<Response> {
  const expected = process.env.NEON_FUNCTION_API_KEY;
  if (expected === undefined || expected === '') {
    return new Response('Function misconfigured', { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  return Response.json({
    ok: true,
    service: 'neon-function',
    branch: process.env.NEON_BRANCH ?? null,
  });
}
