#!/usr/bin/env node
/**
 * scripts/seed-demo.mjs
 *
 * Idempotent demo account seeder. Creates a demo user, tops up credits,
 * creates a workspace, and creates a brand — safe to run repeatedly.
 *
 * Reads from env:
 *   BASE_URL              (default: http://localhost:4000)
 *   DEMO_ACCOUNT_EMAIL    (default: demo@renderflow.dev)
 *   DEMO_ACCOUNT_PASSWORD (default: Demo1234!)
 *   DEMO_ACCOUNT_CREDITS  (default: 100)
 *   ADMIN_TOKEN           (optional — required for credit top-up)
 *
 * Uses only built-in fetch() (Node 22+). No npm dependencies.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4000';
const EMAIL = process.env.DEMO_ACCOUNT_EMAIL ?? 'demo@renderflow.dev';
const PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD ?? 'Demo1234!';
const TARGET_CREDITS = parseInt(process.env.DEMO_ACCOUNT_CREDITS ?? '100', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

const API = `${BASE_URL}/api/v1`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }

  return { status: res.status, ok: res.ok, json };
}

function log(msg) {
  process.stdout.write(`[seed-demo] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[seed-demo] ERROR: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1 — Register (idempotent via 409 check)
// ---------------------------------------------------------------------------

async function registerDemoUser() {
  const res = await request('POST', '/auth/register', {
    email: EMAIL,
    password: PASSWORD,
    name: 'Demo User',
  });

  if (res.status === 201) {
    log('Demo user created');
  } else if (res.status === 409) {
    log('Demo user already exists');
  } else {
    fail(`Unexpected status from /auth/register: ${res.status} — ${JSON.stringify(res.json)}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Log in and return access token
// ---------------------------------------------------------------------------

async function login() {
  const res = await request('POST', '/auth/login', { email: EMAIL, password: PASSWORD });

  if (!res.ok) {
    fail(`Login failed: ${res.status} — ${JSON.stringify(res.json)}`);
  }

  // The API returns the token in the response body under `accessToken`
  const token = res.json?.accessToken ?? res.json?.data?.accessToken;
  if (!token) {
    fail(`No access token in login response: ${JSON.stringify(res.json)}`);
  }

  log('Login successful');
  return token;
}

// ---------------------------------------------------------------------------
// Step 3 — Check and optionally top up credits
// ---------------------------------------------------------------------------

async function ensureCredits(token) {
  const res = await request('GET', '/credits/balance', null, token);

  if (!res.ok) {
    fail(`Could not read credit balance: ${res.status} — ${JSON.stringify(res.json)}`);
  }

  const available = res.json?.available ?? res.json?.data?.available ?? 0;
  log(`Current credit balance: ${available}`);

  if (available >= TARGET_CREDITS) {
    log(`Balance already meets target (${TARGET_CREDITS}). No top-up needed.`);
    return available;
  }

  if (!ADMIN_TOKEN) {
    log(`Balance is below target (${TARGET_CREDITS}) but ADMIN_TOKEN is not set. Skipping top-up.`);
    return available;
  }

  const delta = TARGET_CREDITS - available;
  log(`Topping up by ${delta} credits (${available} → ${TARGET_CREDITS})...`);

  const userId = res.json?.userId ?? res.json?.data?.userId;
  if (!userId) {
    log('WARNING: userId not present in balance response — cannot top up. Skipping.');
    return available;
  }

  const adjustRes = await request(
    'POST',
    `/admin/credits/adjust`,
    { userId, amount: delta, reason: 'Demo account top-up' },
    ADMIN_TOKEN,
  );

  if (!adjustRes.ok) {
    log(
      `WARNING: Credit top-up failed: ${adjustRes.status} — ${JSON.stringify(adjustRes.json)}. Continuing.`,
    );
    return available;
  }

  log(`Credits topped up to ${TARGET_CREDITS}`);
  return TARGET_CREDITS;
}

// ---------------------------------------------------------------------------
// Step 4 — Create workspace (idempotent: skip if one named 'Demo Workspace' exists)
// ---------------------------------------------------------------------------

async function ensureWorkspace(token) {
  // List existing workspaces
  const listRes = await request('GET', '/workspaces', null, token);

  if (!listRes.ok) {
    fail(`Could not list workspaces: ${listRes.status} — ${JSON.stringify(listRes.json)}`);
  }

  const workspaces = listRes.json?.data ?? listRes.json ?? [];
  const existing = Array.isArray(workspaces)
    ? workspaces.find((w) => w.name === 'Demo Workspace')
    : null;

  if (existing) {
    log(`Workspace 'Demo Workspace' already exists (id: ${existing.id})`);
    return existing;
  }

  const createRes = await request('POST', '/workspaces', { name: 'Demo Workspace' }, token);

  if (!createRes.ok) {
    fail(`Could not create workspace: ${createRes.status} — ${JSON.stringify(createRes.json)}`);
  }

  const workspace = createRes.json?.data ?? createRes.json;
  log(`Workspace 'Demo Workspace' created (id: ${workspace.id})`);
  return workspace;
}

// ---------------------------------------------------------------------------
// Step 5 — Create brand (idempotent: skip if one named 'Demo Brand' exists)
// ---------------------------------------------------------------------------

async function ensureBrand(token, workspaceId) {
  // List existing brands in this workspace
  const listRes = await request('GET', `/workspaces/${workspaceId}/brands`, null, token);

  if (!listRes.ok) {
    fail(`Could not list brands: ${listRes.status} — ${JSON.stringify(listRes.json)}`);
  }

  const brands = listRes.json?.data ?? listRes.json ?? [];
  const existing = Array.isArray(brands) ? brands.find((b) => b.name === 'Demo Brand') : null;

  if (existing) {
    log(`Brand 'Demo Brand' already exists (id: ${existing.id})`);
    return existing;
  }

  const createRes = await request(
    'POST',
    `/workspaces/${workspaceId}/brands`,
    {
      name: 'Demo Brand',
      primaryColor: '#E67E22',
    },
    token,
  );

  if (!createRes.ok) {
    fail(`Could not create brand: ${createRes.status} — ${JSON.stringify(createRes.json)}`);
  }

  const brand = createRes.json?.data ?? createRes.json;
  log(`Brand 'Demo Brand' created (id: ${brand.id})`);
  return brand;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Starting demo seed against ${API}`);
  log(`Target account: ${EMAIL}`);
  log(`Target credits: ${TARGET_CREDITS}`);
  log('');

  await registerDemoUser();
  const token = await login();
  const credits = await ensureCredits(token);
  const workspace = await ensureWorkspace(token);
  const brand = await ensureBrand(token, workspace.id);

  log('');
  log('────────────────────────────────────');
  log('Demo seed complete');
  log(`  Email:     ${EMAIL}`);
  log(`  Credits:   ${credits}`);
  log(`  Workspace: ${workspace.name} (id: ${workspace.id})`);
  log(`  Brand:     ${brand.name} (id: ${brand.id})`);
  log('────────────────────────────────────');
}

main().catch((err) => {
  process.stderr.write(`[seed-demo] Unhandled error: ${err.message}\n`);
  process.exit(1);
});
