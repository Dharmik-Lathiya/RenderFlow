#!/usr/bin/env node
/**
 * scripts/seed-demo.mjs
 *
 * Idempotent demo account seeder. Creates a demo user, tops up credits, and
 * creates a brand and campaign the demo can generate from - safe to run
 * repeatedly.
 *
 * Reads from env:
 *   BASE_URL              (default: http://localhost:4000)
 *   DEMO_ACCOUNT_EMAIL    (default: demo@renderflow.dev)
 *   DEMO_ACCOUNT_PASSWORD (default: Demo1234!)
 *   DEMO_ACCOUNT_CREDITS  (default: 100)
 *   ADMIN_TOKEN           (optional - required for credit top-up)
 *
 * Uses only built-in fetch() (Node 22+). No npm dependencies.
 *
 * Why this is a script over HTTP rather than SQL: it has to exercise the same
 * signup-bonus, workspace-membership and credit paths a real user does. A seeder
 * that inserted rows directly could produce a demo account whose wallet does not
 * reconcile with its ledger - the one thing the credit tests exist to prevent.
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

/** The API returns bare lists, but tolerate a wrapper from a future version. */
function asList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function log(msg) {
  process.stdout.write(`[seed-demo] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[seed-demo] ERROR: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1 - Register (idempotent via 409 check)
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
    fail(`Unexpected status from /auth/register: ${res.status} - ${JSON.stringify(res.json)}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2 - Log in and return access token
// ---------------------------------------------------------------------------

async function login() {
  const res = await request('POST', '/auth/login', { email: EMAIL, password: PASSWORD });

  if (!res.ok) {
    fail(`Login failed: ${res.status} - ${JSON.stringify(res.json)}`);
  }

  const token = res.json?.accessToken ?? res.json?.data?.accessToken;
  if (!token) {
    fail(`No access token in login response: ${JSON.stringify(res.json)}`);
  }

  log('Login successful');
  return token;
}

// ---------------------------------------------------------------------------
// Step 3 - Check and optionally top up credits
// ---------------------------------------------------------------------------

async function fetchIdentity(token) {
  const res = await request('GET', '/auth/me', null, token);

  if (!res.ok) {
    fail(`Could not read the demo profile: ${res.status} - ${JSON.stringify(res.json)}`);
  }

  const user = res.json?.user ?? res.json?.data?.user;
  const wallet = res.json?.wallet ?? res.json?.data?.wallet;
  if (!user?.id) {
    fail(`No user id in /auth/me response: ${JSON.stringify(res.json)}`);
  }

  return { userId: user.id, available: wallet?.available ?? 0, reserved: wallet?.reserved ?? 0 };
}

async function ensureCredits(token, identity) {
  log(`Current credit balance: ${identity.available} available, ${identity.reserved} reserved`);

  if (identity.available >= TARGET_CREDITS) {
    log(`Balance already meets target (${TARGET_CREDITS}). No top-up needed.`);
    return identity.available;
  }

  if (!ADMIN_TOKEN) {
    log(`Balance is below target (${TARGET_CREDITS}) but ADMIN_TOKEN is not set. Skipping top-up.`);
    return identity.available;
  }

  const delta = TARGET_CREDITS - identity.available;
  log(`Topping up by ${delta} credits (${identity.available} -> ${TARGET_CREDITS})...`);

  const adjustRes = await request(
    'POST',
    '/admin/credits/adjust',
    { userId: identity.userId, amount: delta, reason: 'Demo account top-up' },
    ADMIN_TOKEN,
  );

  if (!adjustRes.ok) {
    log(
      `WARNING: Credit top-up failed: ${adjustRes.status} - ${JSON.stringify(
        adjustRes.json,
      )}. Continuing.`,
    );
    return identity.available;
  }

  log(`Credits topped up to ${TARGET_CREDITS}`);
  return TARGET_CREDITS;
}

// ---------------------------------------------------------------------------
// Step 4 - Use the personal workspace registration created
// ---------------------------------------------------------------------------

/**
 * Registration creates `${name}'s workspace` in the same transaction as the
 * user. There is no public endpoint to create a second one, so the demo
 * deliberately uses the one it is a member of instead of inventing one.
 */
async function ensureWorkspace(token) {
  const listRes = await request('GET', '/workspaces', null, token);

  if (!listRes.ok) {
    fail(`Could not list workspaces: ${listRes.status} - ${JSON.stringify(listRes.json)}`);
  }

  const workspaces = asList(listRes.json);
  const existing =
    workspaces.find((w) => typeof w.name === 'string' && w.name.includes('Demo')) ?? workspaces[0];

  if (!existing) {
    fail('The demo user has no workspace; registration normally creates one');
  }

  log(`Using workspace '${existing.name}' (id: ${existing.id})`);
  return existing;
}

// ---------------------------------------------------------------------------
// Step 5 - Create brand (idempotent: skip if one named 'Demo Brand' exists)
// ---------------------------------------------------------------------------

async function ensureBrand(token, workspaceId) {
  const listRes = await request('GET', `/brands?workspaceId=${workspaceId}`, null, token);

  if (!listRes.ok) {
    fail(`Could not list brands: ${listRes.status} - ${JSON.stringify(listRes.json)}`);
  }

  const brands = asList(listRes.json);
  const existing = brands.find((b) => b.name === 'Demo Brand');

  if (existing) {
    log(`Brand 'Demo Brand' already exists (id: ${existing.id})`);
    return existing;
  }

  const createRes = await request(
    'POST',
    '/brands',
    {
      workspaceId,
      name: 'Demo Brand',
      industry: 'food and beverage',
      tone: 'warm, celebratory, local',
      audience: 'families and young professionals celebrating festivals',
      // A brand with no palette renders a grey poster, so the demo seeds the
      // colours the festival templates expect rather than leaving it empty.
      colors: ['#E67E22', '#7C3AED', '#F59E0B'],
      languages: ['en', 'hi'],
    },
    token,
  );

  if (!createRes.ok) {
    fail(`Could not create brand: ${createRes.status} - ${JSON.stringify(createRes.json)}`);
  }

  const brand = createRes.json;
  log(`Brand 'Demo Brand' created (id: ${brand.id})`);
  return brand;
}

// ---------------------------------------------------------------------------
// Step 6 - Create a campaign the festival flow can attach to
// ---------------------------------------------------------------------------

async function ensureCampaign(token, brandId) {
  const listRes = await request('GET', `/brands/${brandId}/campaigns`, null, token);

  if (!listRes.ok) {
    fail(`Could not list campaigns: ${listRes.status} - ${JSON.stringify(listRes.json)}`);
  }

  const campaigns = asList(listRes.json);
  const existing = campaigns.find((c) => c.goal === 'Festival marketing demo');

  if (existing) {
    log(`Campaign '${existing.goal}' already exists (id: ${existing.id})`);
    return existing;
  }

  const createRes = await request(
    'POST',
    '/campaigns',
    { brandId, goal: 'Festival marketing demo' },
    token,
  );

  if (!createRes.ok) {
    fail(`Could not create campaign: ${createRes.status} - ${JSON.stringify(createRes.json)}`);
  }

  const campaign = createRes.json;
  log(`Campaign '${campaign.goal}' created (id: ${campaign.id})`);
  return campaign;
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
  const identity = await fetchIdentity(token);
  const credits = await ensureCredits(token, identity);
  const workspace = await ensureWorkspace(token);
  const brand = await ensureBrand(token, workspace.id);
  const campaign = await ensureCampaign(token, brand.id);

  log('');
  log('------------------------------------');
  log('Demo seed complete');
  log(`  Email:     ${EMAIL}`);
  log(`  Credits:   ${credits} available`);
  log(`  Workspace: ${workspace.name} (id: ${workspace.id})`);
  log(`  Brand:     ${brand.name} (id: ${brand.id})`);
  log(`  Campaign:  ${campaign.goal} (id: ${campaign.id})`);
  log('');
  log('Open the campaign and use "Festival Campaign" to try the Phase 11 flow.');
  log('------------------------------------');
}

main().catch((err) => {
  process.stderr.write(`[seed-demo] Unhandled error: ${err.message}\n`);
  process.exit(1);
});
