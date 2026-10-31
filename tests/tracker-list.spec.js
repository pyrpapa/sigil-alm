import { test, expect } from '@playwright/test'

// The tracker list: requirements / test cases tabs, state summary, selecting several
// items and moving them in one action, and previewing an item without leaving the list.
// Creates data, so it runs only against the throwaway CI database (E2E_ALLOW_WRITES=true).
// Tag with the TC IDs once the requirements for these features are written.
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function newRequirement(page, listUrl, title, er) {
  await page.goto(listUrl)
  await page.getByRole('button', { name: 'New SRS item' }).click()
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Add ER' }).click()
  await page.getByLabel('ER 1', { exact: true }).fill(er)
  await page.getByLabel('Verification method').selectOption('Test (automated)')
  await page.getByRole('button', { name: 'Create item' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(title) })).toBeVisible()
}

test('tracker list: tabs, state summary, bulk move and preview', { tag: '@tracker-list' }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  await signIn(page)
  const name = `E2E List ${Date.now()}`
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name }).click()
  const listUrl = `${page.url().replace(/\/$/, '')}/trackers/SRS`

  await newRequirement(page, listUrl, 'Sign-in required', 'System requires users to sign in')
  await newRequirement(page, listUrl, 'Project list', 'System displays the projects a user is assigned to')
  await newRequirement(page, listUrl, 'Audit every change', 'System records an audit entry for every change')
  await page.goto(listUrl)

  // Requirements and test cases are two tabs of one page; the TC tracker's own URL lands on its tab
  await expect(page.getByRole('button', { name: 'Requirements (3)' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Test cases (3)' }).click()
  await expect(page.getByRole('table', { name: 'TC items' })).toContainText('TC-003')
  await page.goto(listUrl.replace(/SRS$/, 'TC'))
  await expect(page).toHaveURL(/\/trackers\/SRS\?view=tc$/)
  await page.getByRole('button', { name: 'Requirements (3)' }).click()

  // The state summary counts items per state and filters by one
  const summary = page.getByRole('group', { name: 'Items by state' })
  await expect(summary.getByRole('button', { name: /^New\s*3$/ })).toBeVisible()
  await summary.getByRole('button', { name: /^New/ }).click()
  await expect(page.getByText('Showing 3 of 3')).toBeVisible()

  // Select two, then all shown, and move them together
  await page.getByLabel('Select SRS-001').check()
  await page.getByLabel('Select SRS-002').check()
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('2 selected')
  await page.getByLabel(/^Select all 3 shown/).check()
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('3 selected')
  await page.getByRole('button', { name: 'Move state…' }).click()
  await page.getByLabel('Move to').selectOption({ label: 'In Progress' })
  await expect(page.getByText('3 of 3 will move to')).toBeVisible()
  await page.getByRole('button', { name: 'Move 3 items' }).click()
  await expect(page.getByRole('status')).toContainText('Moved 3 items.')
  await expect(summary.getByRole('button', { name: /^In Progress\s*3$/ })).toBeVisible()

  // Each item moved through its own workflow call, so each has its own history entry
  await summary.getByRole('button', { name: /^New/ }).click()
  await page.getByRole('link', { name: 'SRS-002' }).click()
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('In Progress').first()).toBeVisible()
  await page.goBack()

  // Preview an item from the list, move through the list with the keyboard, close with Esc
  await page.getByRole('button', { name: 'Preview SRS-001 Sign-in required' }).click()
  const preview = page.getByRole('complementary', { name: 'Preview of SRS-001' })
  await expect(preview).toContainText('System requires users to sign in')
  await expect(preview).toContainText('TC-001')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('complementary', { name: 'Preview of SRS-002' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary')).toHaveCount(0)
})
