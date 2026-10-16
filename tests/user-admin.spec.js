import { test, expect } from '@playwright/test'

// User accounts (SRS-002): a System Admin creates an account with a starting
// password; the person signs in with it and sets their own password.
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

test('System Admin creates an account; the new user signs in and changes their password', { tag: ['@SRS-002'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  const email = `new-${Date.now()}@sigil.test`

  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('link', { name: 'Users' }).click()
  await page.getByRole('button', { name: 'New user' }).click()
  await page.getByLabel('Email (used to sign in)').fill(email)
  await page.getByLabel('Printed name').fill('Nora New')
  await page.getByLabel(/Starting password/).fill('starting-pass-1')
  await page.getByRole('button', { name: 'Create user' }).click()
  await expect(page.getByRole('status')).toContainText(`Account created for Nora New`)
  await expect(page.getByRole('table', { name: 'Users' })).toContainText(email)
  await page.getByRole('button', { name: 'Sign out' }).click()

  // The new person signs in with what they were given, then picks their own password
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('starting-pass-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)
  await page.getByRole('link', { name: email }).click()
  await page.getByLabel('Current password').fill('starting-pass-1')
  await page.getByLabel(/^New password \(/).fill('my-own-password-1')
  await page.getByLabel('New password again').fill('my-own-password-1')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('my-own-password-1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
})
