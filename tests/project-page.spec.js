import { test, expect } from '@playwright/test'

// Creates data: runs only against the throwaway CI database (E2E_ALLOW_WRITES=true).
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function createAndOpenProject(page, name) {
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByLabel('System under validation').fill('Sigil v1.0')
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

test('project page: edit with a reason and see it in the audit trail', { tag: ['@SRS-028', '@SRS-029'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  await signIn(page)
  const name = `E2E Page ${Date.now()}`
  await createAndOpenProject(page, name)

  // Overview: edit the planned end date with a reason
  await page.getByRole('button', { name: 'Edit details' }).click()
  await page.getByLabel('Planned end').fill('2026-12-31')
  await page.getByLabel('Reason for change (recorded in the audit trail)').fill('Schedule agreed with QA')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Dec 31, 2026')).toBeVisible()

  // Activity: creation, membership and the edit with its reason
  await page.getByRole('link', { name: 'Activity' }).click()
  const audit = page.getByRole('table', { name: 'Audit trail' })
  await expect(audit.getByRole('row').filter({ hasText: 'Created the project' })).toBeVisible()
  await expect(audit.getByRole('row').filter({ hasText: 'as Admin' })).toBeVisible()
  const edit = audit.getByRole('row').filter({ hasText: 'Edited project details' })
  await expect(edit).toContainText('Planned end')
  await expect(edit).toContainText('2026-12-31')
  await expect(edit).toContainText('Schedule agreed with QA')
})

test('project page: members and repository link', { tag: ['@SRS-012'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  await signIn(page)
  await createAndOpenProject(page, `E2E Members ${Date.now()}`)

  await page.getByRole('link', { name: 'Members' }).click()
  const me = page.getByRole('table', { name: 'Members' }).getByRole('row').filter({ hasText: '(you)' })
  await expect(me).toContainText(process.env.E2E_EMAIL)

  // Adding an email with no account is refused with a clear message
  await page.getByRole('button', { name: 'Add member' }).click()
  await page.getByLabel('Email').fill('nobody@sigil.test')
  await page.getByRole('button', { name: 'Add member' }).click()
  await expect(page.getByRole('alert')).toContainText('No Sigil account uses that email')
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Repository link is saved and audited
  await page.getByRole('link', { name: 'Repository' }).click()
  await page.getByRole('button', { name: 'Link a repository' }).click()
  await page.getByLabel('GitHub repository URL').fill('https://github.com/pyrpapa/sigil-alm.git')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('link', { name: 'https://github.com/pyrpapa/sigil-alm' })).toBeVisible()

  await page.getByRole('link', { name: 'Activity' }).click()
  await expect(page.getByRole('table', { name: 'Audit trail' })).toContainText('Linked a repository')
})

test('tracker preview: SRS list and a manual test run', async ({ page }) => {
  test.skip(!writesAllowed, 'Needs a project, so runs only against the throwaway CI database')
  await signIn(page)
  await createAndOpenProject(page, `E2E Preview ${Date.now()}`)

  await page.getByRole('link', { name: 'Trackers' }).click()
  await page.getByRole('link', { name: /SRS\s/ }).click()
  await expect(page.getByRole('table', { name: 'SRS items' })).toContainText('Project access')

  // Open the manual test case and run it
  await page.goto(page.url().replace(/\/trackers\/SRS$/, '/trackers/TC/TC-004'))
  await page.getByRole('link', { name: 'Run this test' }).click()
  // Wait until every step is on screen before filling them in
  const steps = page.locator('.run-step')
  await expect(steps).toHaveCount(5)
  for (let i = 0; i < 5; i++) {
    await steps.nth(i).getByLabel('Actual result').fill('As expected')
    await steps.nth(i).getByRole('button', { name: 'Pass' }).click()
  }
  await expect(page.getByText('5 of 5 steps recorded')).toBeVisible()
  await page.getByRole('button', { name: 'Finish and sign…' }).click()
  await page.getByLabel('Re-enter your password').fill('preview')
  await page.getByRole('button', { name: 'Sign as Executed' }).click()
  await expect(page.getByText('recorded (preview)')).toBeVisible()
})
