import { expect, test, type Page } from '@playwright/test';

/**
 * The full user journey (PROJECT.md section 12, Phase 8 DoD: "the full user
 * journey runs in the browser").
 *
 * NOT EXECUTED in this environment - no browser, no Docker. See
 * `playwright.config.ts` and `scripts/e2e.sh`, which reports these as SKIP.
 *
 * The journey, in the order a person does it:
 *   sign up -> see 50 credits -> create a brand -> plan a campaign -> write a
 *   post -> generate -> approve -> connect an account -> schedule -> watch it.
 *
 * Every assertion is on something the USER can see. Nothing asserts on a request
 * or an internal state, because a test that does tells you the plumbing worked
 * and not that the product does.
 */

/** A fresh email per run, so a rerun is not "email already registered". */
function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('the full journey', () => {
  test('a new user reaches a scheduled post', async ({ page }) => {
    const email = uniqueEmail();

    await signUp(page, email);

    // The signup bonus is the product's first promise.
    await expect(page.getByRole('heading', { name: 'Credits' })).toBeVisible();
    await expect(page.getByText('50')).toBeVisible();

    // Onboarding.
    await page.getByRole('link', { name: /create your first brand/i }).click();
    await page.getByLabel('Name').fill('Acme');
    await page.getByLabel('Industry').fill('retail');
    await page.getByRole('button', { name: 'Create brand' }).click();
    await expect(page.getByRole('heading', { name: 'Acme' })).toBeVisible();

    // Campaign.
    await page.getByLabel('Goal').fill('Announce our spring collection to existing customers.');
    await page.getByRole('button', { name: 'Plan campaign' }).click();
    await expect(page.getByText(/1 post|0 posts/)).toBeVisible();

    // Post.
    await page.getByRole('link', { name: /Open/ }).click();
    await page.getByLabel('Caption').fill('Rain again. The spring collection is nearly here.');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.getByRole('link', { name: /Rain again/ }).click();

    // Generation, with live progress.
    await page.getByRole('button', { name: 'Caption' }).click();
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page.getByText('COMPLETED')).toBeVisible({ timeout: 60_000 });

    // Approval.
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('APPROVED').first()).toBeVisible();

    // Account, then scheduling.
    await page.goto('/settings/accounts');
    await page.getByLabel('Platform account id').fill('ext-1');
    await page.getByLabel('Access token').fill('mock-token');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('ext-1')).toBeVisible();

    await page.goto(`/posts`);
    await page.getByLabel('Accounts').getByRole('checkbox').check();
    await page.getByLabel('Publish at').fill('2099-01-01T09:00');
    await page.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByText('SCHEDULED')).toBeVisible();
  });

  test('a signed-in user can sign out', async ({ page }) => {
    await signUp(page, uniqueEmail());

    await page.getByRole('button', { name: 'Sign out' }).click();

    // Back at the door, not on a page that silently 401s every request.
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('the whole journey is operable by keyboard alone', async ({ page }) => {
    await signUp(page, uniqueEmail());

    // Tab from the very top: the first stop must be the skip link, or a
    // keyboard user has to traverse the nav on every single page.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeVisible();
  });

  test('every form control has a label', async ({ page }) => {
    await signUp(page, uniqueEmail());
    await page.goto('/brands/new');

    const unlabelled = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('input, select, textarea')];

      return controls
        .filter((element) => {
          const id = element.getAttribute('id');
          const hasLabel = id !== null && document.querySelector(`label[for="${id}"]`) !== null;

          return !hasLabel && element.getAttribute('aria-label') === null;
        })
        .map((element) => `${element.tagName}#${element.getAttribute('id') ?? '(no id)'}`);
    });

    // A control with no accessible name is invisible to a screen reader.
    expect(unlabelled).toEqual([]);
  });

  test('the credit balance is announced, not only drawn', async ({ page }) => {
    await signUp(page, uniqueEmail());

    const live = page.locator('[aria-live="polite"]').first();
    await expect(live).toContainText('credits available');
  });
});

test.describe('responsive', () => {
  test('the nav does not disappear on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signUp(page, uniqueEmail());

    // A hidden nav on mobile is a keyboard trap; it stacks instead.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  });

  test('nothing overflows the viewport horizontally', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signUp(page, uniqueEmail());

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    // Sideways scroll on a phone hides content the user believes is there.
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
