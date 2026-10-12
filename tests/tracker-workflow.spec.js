import { test, expect } from '@playwright/test'

// Full review loop across two users. Creates data, so it runs only against the
// throwaway CI database (E2E_ALLOW_WRITES=true), where seed.sql provides both users.
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'
const QA_EMAIL = process.env.E2E_QA_EMAIL ?? 'e2e-qa@sigil.test'
const QA_PASSWORD = process.env.E2E_QA_PASSWORD ?? process.env.E2E_PASSWORD

async function signIn(page, email, password) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

test('SRS item: author, review gate, QA signature, approval', { tag: ['@SRS-021', '@SRS-022', '@SRS-023', '@SRS-025', '@SRS-027'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  const projectName = `E2E Workflow ${Date.now()}`

  // Author: create a project, add the QA reviewer, write a requirement
  await signIn(page, process.env.E2E_EMAIL, process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: projectName }).click()
  const projectUrl = page.url()

  await page.getByRole('link', { name: 'Members' }).click()
  await page.getByRole('button', { name: 'Add member' }).click()
  await page.getByLabel('Email').fill(QA_EMAIL)
  await page.getByLabel('Role', { exact: true }).selectOption('qa')
  await page.getByRole('button', { name: 'Add member' }).click()
  await expect(page.getByRole('table', { name: 'Members' })).toContainText(QA_EMAIL)

  await page.goto(`${projectUrl}/trackers/SRS`)
  await page.getByRole('button', { name: 'New SRS item' }).click()
  await page.getByLabel('Title').fill('Sign-in required')
  await page.getByLabel('Requirement').fill('System requires users to sign in before any project data is displayed.')
  await page.getByLabel('Verification method').selectOption('Test (automated)')
  await page.getByRole('button', { name: 'Create item' }).click()
  await expect(page.getByRole('heading', { name: /SRS-001/ })).toBeVisible()

  await page.getByRole('button', { name: 'Move to In Progress' }).click()
  await page.getByRole('button', { name: 'Move to In Progress' }).last().click()
  await page.getByRole('button', { name: 'Move to In Review' }).click()
  await page.getByRole('button', { name: 'Move to In Review' }).last().click()

  // In review: locked and waiting; the author can't sign or approve
  await expect(page.getByRole('status').filter({ hasText: 'Waiting for review' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Move to Approved' })).toBeDisabled()
  await expect(page.getByText('Only a project QA can sign this review.')).toBeVisible()
  const itemUrl = page.url()

  // QA reviewer signs with their password, then approves
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signIn(page, QA_EMAIL, QA_PASSWORD)
  await page.goto(itemUrl)
  await page.getByRole('button', { name: /Sign review/ }).click()
  await page.getByLabel('Re-enter your password').fill('not-my-password')
  await page.getByRole('button', { name: 'Sign as Approved' }).click()
  await expect(page.getByRole('alert')).toContainText('Password incorrect')

  await page.getByLabel('Re-enter your password').fill(QA_PASSWORD)
  await page.getByRole('button', { name: 'Sign as Approved' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Reviewed.' })).toContainText('E2E QA Reviewer')

  await page.getByRole('button', { name: 'Move to Approved' }).click()
  await page.getByRole('button', { name: 'Move to Approved' }).last().click()
  await expect(page.locator('.badge', { hasText: 'Approved' }).first()).toBeVisible()
  await expect(page.getByText('Approved items are locked. Move back to edit.')).toBeVisible()

  await page.getByRole('button', { name: /Signatures/ }).click()
  await expect(page.getByText('E2E QA Reviewer')).toBeVisible()
})

test('TC item: documentation and verification steps', { tag: ['@SRS-034', '@SRS-049'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  const projectName = `E2E Steps ${Date.now()}`
  await signIn(page, process.env.E2E_EMAIL, process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: projectName }).click()
  await page.goto(`${page.url().replace(/\/$/, '')}/trackers/TC`)

  await page.getByRole('button', { name: 'New TC item' }).click()
  await page.getByLabel('Title').fill('Login page loads')
  await page.getByLabel('Execution type').selectOption('Manual')

  // Step 1: documentation step with two values to record
  await page.getByRole('button', { name: 'Add documentation step' }).click()
  const steps = page.locator('.step-row')
  await steps.nth(0).getByLabel(/Action/).fill('Record the test environment')
  await page.getByLabel('Step 1 value 1').fill('Browser and version')
  await page.getByRole('button', { name: 'Add value' }).click()
  await page.getByLabel('Step 1 value 2').fill('Operating system')

  // Step 2: ordinary verification step
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await steps.nth(1).getByLabel(/Action/).fill('Open the login page')
  await steps.nth(1).getByLabel('Expected result').fill('The Sign in button is visible')
  await page.getByRole('button', { name: 'Create item' }).click()

  await expect(page.getByRole('heading', { name: /TC-001/ })).toBeVisible()
  const table = page.getByRole('table', { name: 'Steps' })
  await expect(table.getByRole('row').nth(1)).toContainText('Record the test environment')
  await expect(table.getByRole('row').nth(1)).toContainText('Browser and version')
  await expect(table.getByRole('row').nth(1)).toContainText('Operating system')
  await expect(table.getByRole('row').nth(2)).toContainText('The Sign in button is visible')
})
