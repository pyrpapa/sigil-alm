import { test, expect } from '@playwright/test'

// The SRS/TC pair through its whole workflow across three users. Creates data, so it
// runs only against the throwaway CI database (E2E_ALLOW_WRITES=true), where seed.sql
// provides the author, a Val (Specialist) reviewer and a QA reviewer.
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'
const PASSWORD = process.env.E2E_PASSWORD
const VAL_EMAIL = process.env.E2E_VAL_EMAIL ?? 'e2e-val@sigil.test'
const QA_EMAIL = process.env.E2E_QA_EMAIL ?? 'e2e-qa@sigil.test'
const QA_NAME = process.env.E2E_QA_NAME ?? 'E2E QA Reviewer'

async function signIn(page, email) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function switchUser(page, email, url) {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await signIn(page, email)
  await page.goto(url)
}

async function newProject(page, name, members = []) {
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name }).click()
  const url = page.url().replace(/\/$/, '')
  for (const [email, role] of members) {
    await page.getByRole('link', { name: 'Members' }).click()
    await page.getByRole('button', { name: 'Add member' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption(role)
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page.getByRole('table', { name: 'Members' })).toContainText(email)
  }
  return url
}

// Move one part of the pair, confirming in its own card.
async function move(page, key, to) {
  const card = page.getByRole('region', { name: `Workflow of ${key}` })
  await card.getByRole('button', { name: `Move to ${to}` }).first().click()
  await card.getByRole('button', { name: `Move to ${to}` }).last().click()
  await expect(page.locator('.pair-row', { hasText: key }).locator('.pair-row-head .badge', { hasText: to })).toBeVisible()
}

async function confirmMove(page, to) {
  await page.getByRole('button', { name: `Move to ${to}` }).first().click()
  await page.getByRole('button', { name: `Move to ${to}` }).last().click()
}

test(
  'SRS/TC pair: checklist, Val review, QA review, approval, new version',
  { tag: ['@SRS-019', '@SRS-020', '@SRS-021', '@SRS-022', '@SRS-023', '@SRS-025', '@SRS-027', '@SRS-034'] },
  async ({ page }) => {
    test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
    await signIn(page, process.env.E2E_EMAIL)
    const projectUrl = await newProject(page, `E2E Pair ${Date.now()}`, [
      [VAL_EMAIL, 'specialist'],
      [QA_EMAIL, 'qa'],
    ])

    // The requirement, with one ER; its test case comes with it
    await page.goto(`${projectUrl}/trackers/SRS`)
    await page.getByRole('button', { name: 'New SRS item' }).click()
    await page.getByLabel('Title').fill('Sign-in required')
    await page.getByRole('button', { name: 'Add ER' }).click()
    await page.getByLabel('ER 1', { exact: true }).fill('System requires users to sign in before any project data is displayed')
    await page.getByLabel('Verification method').selectOption('Test (automated)')
    await page.getByRole('button', { name: 'Create item' }).click()
    await expect(page.getByRole('heading', { name: /SRS-001/ })).toBeVisible()
    await expect(page.getByText('With test case TC-001')).toBeVisible()
    const itemUrl = page.url()

    // The test case can't be Ready until every ER has a step
    await expect(page.getByText('SRS-001.1 has no test step verifying it')).toBeVisible()
    await page.getByRole('region', { name: 'Workflow of TC-001' }).getByRole('button', { name: 'Edit' }).click()
    await page.getByLabel('Execution type').selectOption('Manual')
    await page.getByRole('button', { name: 'Add step', exact: true }).click()
    await page.locator('.step-row').nth(0).getByLabel(/Action/).fill('Open the app signed out')
    await page.locator('.step-row').nth(0).getByLabel('Expected result').fill('The sign-in page is shown')
    await page.getByLabel('ER verified by step 1').selectOption('SRS-001.1')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText('1 of 1 ERs covered by test steps')).toBeVisible()

    for (const key of ['SRS-001', 'TC-001']) {
      await move(page, key, 'In Progress')
      await move(page, key, 'Ready for Review')
    }
    await page.getByRole('button', { name: 'Send both to Val Review' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Waiting for Val Review' })).toBeVisible()
    await expect(page.getByText('Only a project Specialist can sign this review.')).toBeVisible()

    // Val signs once for both
    await switchUser(page, VAL_EMAIL, itemUrl)
    await page.getByRole('button', { name: /Sign Val Review/ }).click()
    await page.getByLabel('Re-enter your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign as Reviewed' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Reviewed.' })).toBeVisible()
    await confirmMove(page, 'QA Review')
    await expect(page.getByRole('status').filter({ hasText: 'Waiting for QA Review' })).toBeVisible()

    // QA: wrong password records nothing; then signs and approves
    await switchUser(page, QA_EMAIL, itemUrl)
    await page.getByRole('button', { name: /Sign QA Review/ }).click()
    await page.getByLabel('Re-enter your password').fill('not-my-password')
    await page.getByRole('button', { name: 'Sign as Approved' }).click()
    await expect(page.getByRole('alert')).toContainText('Password incorrect')
    await page.getByLabel('Re-enter your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign as Approved' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Reviewed.' })).toContainText(QA_NAME)
    await confirmMove(page, 'Approved')
    await expect(page.getByRole('status').filter({ hasText: 'Version 1 of SRS-001 and TC-001 is approved' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0)

    await page.getByRole('button', { name: /Signatures/ }).click()
    await expect(page.getByText(QA_NAME).first()).toBeVisible()

    // A new version for the next change: version 1 stays approved while version 2 is drafted
    await switchUser(page, process.env.E2E_EMAIL, itemUrl)
    await page.getByRole('button', { name: /Start version 2/ }).click()
    await page.getByLabel(/Reason for the change/).fill('Clarify wording')
    await page.getByRole('button', { name: 'Start version 2' }).click()
    await expect(page.getByText('version 1 is approved')).toBeVisible()
    await page.getByRole('button', { name: /Versions/ }).click()
    await expect(page.getByText('approved version in use').first()).toBeVisible()
  },
)

test('Needs Work: reviewer sends the pair back with a reason', { tag: ['@SRS-029'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  await signIn(page, process.env.E2E_EMAIL)
  const projectUrl = await newProject(page, `E2E Rework ${Date.now()}`, [[VAL_EMAIL, 'specialist']])
  await page.goto(`${projectUrl}/trackers/SRS`)
  await page.getByRole('button', { name: 'New SRS item' }).click()
  await page.getByLabel('Title').fill('Archiving')
  await page.getByRole('button', { name: 'Add ER' }).click()
  await page.getByLabel('ER 1', { exact: true }).fill('User is able to archive a project')
  await page.getByLabel('Verification method').selectOption('Test (manual)')
  await page.getByRole('button', { name: 'Create item' }).click()
  await expect(page.getByRole('heading', { name: /SRS-001/ })).toBeVisible()
  const itemUrl = page.url()
  await page.getByRole('region', { name: 'Workflow of TC-001' }).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Execution type').selectOption('Manual')
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await page.locator('.step-row').nth(0).getByLabel(/Action/).fill('Archive the project')
  await page.locator('.step-row').nth(0).getByLabel('Expected result').fill('It shows Archived')
  await page.getByLabel('ER verified by step 1').selectOption('SRS-001.1')
  await page.getByRole('button', { name: 'Save changes' }).click()
  for (const key of ['SRS-001', 'TC-001']) {
    await move(page, key, 'In Progress')
    await move(page, key, 'Ready for Review')
  }
  await page.getByRole('button', { name: 'Send both to Val Review' }).click()

  await switchUser(page, VAL_EMAIL, itemUrl)
  await page.getByRole('button', { name: /Send back/ }).click()
  await page.getByLabel(/What needs to change/).fill('The step must also check the audit trail')
  await page.getByRole('button', { name: 'Add a comment on an ER or step' }).click()
  await page.getByLabel('Comment 1 is about').selectOption({ label: 'TC-001 Step 1' })
  await page.getByLabel('Comment 1', { exact: true }).fill('Check the Activity tab too')
  await page.getByRole('button', { name: 'Send back', exact: true }).click()

  const notice = page.getByRole('alert').filter({ hasText: 'Sent back from Val Review' })
  await expect(notice).toContainText('The step must also check the audit trail')
  await expect(notice).toContainText('TC-001 Step 1')
  await expect(page.getByRole('button', { name: 'Move to Val Review' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move to QA Review' })).toHaveCount(0)
})

test('TC steps: documentation and verification steps', { tag: ['@SRS-034', '@SRS-049'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  await signIn(page, process.env.E2E_EMAIL)
  const projectUrl = await newProject(page, `E2E Steps ${Date.now()}`)
  await page.goto(`${projectUrl}/trackers/SRS`)
  await page.getByRole('button', { name: 'New SRS item' }).click()
  await page.getByLabel('Title').fill('Login page loads')
  await page.getByRole('button', { name: 'Add ER' }).click()
  await page.getByLabel('ER 1', { exact: true }).fill('The login page shows a Sign in button')
  await page.getByLabel('Verification method').selectOption('Test (manual)')
  await page.getByRole('button', { name: 'Create item' }).click()

  await page.getByRole('region', { name: 'Workflow of TC-001' }).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Execution type').selectOption('Manual')

  // Step 1: documentation step with two values to record
  await page.getByRole('button', { name: 'Add documentation step' }).click()
  const steps = page.locator('.step-row')
  await steps.nth(0).getByLabel(/Action/).fill('Record the test environment')
  await page.getByLabel('Step 1 value 1').fill('Browser and version')
  await page.getByRole('button', { name: 'Add value' }).click()
  await page.getByLabel('Step 1 value 2').fill('Operating system')

  // Step 2: verification step for the ER
  await page.getByRole('button', { name: 'Add step', exact: true }).click()
  await steps.nth(1).getByLabel(/Action/).fill('Open the login page')
  await steps.nth(1).getByLabel('Expected result').fill('The Sign in button is visible')
  await page.getByLabel('ER verified by step 2').selectOption('SRS-001.1')
  await page.getByRole('button', { name: 'Save changes' }).click()

  const table = page.getByRole('table', { name: 'Steps' })
  await expect(table.getByRole('row').nth(1)).toContainText('Record the test environment')
  await expect(table.getByRole('row').nth(1)).toContainText('Browser and version')
  await expect(table.getByRole('row').nth(1)).toContainText('Operating system')
  await expect(table.getByRole('row').nth(2)).toContainText('SRS-001.1')
  await expect(table.getByRole('row').nth(2)).toContainText('The Sign in button is visible')
})
