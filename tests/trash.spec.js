import { test, expect } from '@playwright/test'

// The trash: items, folders and trackers are deleted with a reason and restored from
// the project's Trash tab. Release links must come off first. Creates data, so it runs
// only against the throwaway CI database (E2E_ALLOW_WRITES=true).
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

const SRS_CSV = `id,folder,title,requirement,verification,status
SRS-001,Access,Sign-in required,Users sign in before seeing data.,Test (automated),Draft
SRS-002,Access,Project access,Members see only their projects.,Test (automated),Draft
SRS-003,,Audit trail,Every change is recorded.,Test (automated),Draft
`
const csv = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function restore(page, project, label) {
  await page.goto(`${project}/trash`)
  await page.getByRole('button', { name: `Restore ${label}` }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(`Restored: ${label}`)
}

test('Delete to the trash and restore: item, folder, tracker', { tag: ['@SRS-059'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  const projectName = `E2E Trash ${Date.now()}`
  await signIn(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: projectName }).click()
  const project = page.url().replace(/\/$/, '')
  const srsList = page.getByRole('table', { name: 'SRS items' })

  await page.goto(`${project}/trackers/SRS/import`)
  await page.getByLabel('Choose a CSV file').setInputFiles(csv('srs.csv', SRS_CSV))
  await page.getByRole('button', { name: 'Import 3 items' }).click()
  await expect(page.getByRole('status')).toContainText('Imported 3 items')

  // An item planned for a release cannot be deleted until the release is cleared
  await page.goto(`${project}/trackers/REL`)
  await page.getByRole('button', { name: 'New REL item' }).click()
  await page.getByLabel('Title').fill('v1.0')
  await page.getByRole('button', { name: /^(Create|Save)/ }).click()
  await page.goto(`${project}/trackers/SRS/SRS-003`)
  await page.getByLabel('Target release').first().selectOption({ label: 'REL-001 v1.0' })
  await page.getByRole('button', { name: 'Move to trash…' }).click()
  await page.getByLabel('Reason (required, recorded in the audit trail)').fill('Out of scope')
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Remove the release links first: SRS-003 is planned for REL-001')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByLabel('Target release').first().selectOption('')

  // Item: the requirement and its test case go together
  await page.getByRole('button', { name: 'Move to trash…' }).click()
  await expect(page.getByRole('form', { name: 'Move SRS-003 and TC-003 to the trash?' })).toBeVisible()
  await page.getByLabel('Reason (required, recorded in the audit trail)').fill('Out of scope')
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click()
  await expect(srsList).toBeVisible()
  await expect(srsList).not.toContainText('SRS-003')

  await page.getByRole('link', { name: 'Trash' }).click()
  const trash = page.getByRole('table', { name: 'Trash' })
  await expect(trash).toContainText('SRS-003 + TC-003 Audit trail')
  await expect(trash).toContainText('Out of scope')
  await restore(page, project, 'SRS-003 + TC-003 Audit trail')
  await page.goto(`${project}/trackers/SRS`)
  await expect(srsList).toContainText('SRS-003')

  // Folder: takes its items with it
  await page.getByRole('button', { name: /^Access/ }).click()
  await page.getByRole('button', { name: 'Delete folder Access' }).click()
  await page.getByLabel('Reason (required, recorded in the audit trail)').fill('Regrouping')
  await page.getByRole('button', { name: 'Delete folder', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Access/ })).toHaveCount(0)
  await expect(srsList).not.toContainText('SRS-001')
  await expect(srsList).toContainText('SRS-003')
  await restore(page, project, 'Folder "Access" in SRS')
  await page.goto(`${project}/trackers/SRS`)
  await expect(srsList).toContainText('SRS-001')
  await expect(srsList).toContainText('SRS-002')

  // Tracker
  await page.goto(`${project}/trackers/RISK/config`)
  await page.getByRole('button', { name: 'Delete tracker…' }).click()
  await page.getByLabel('Reason (required, recorded in the audit trail)').fill('Risks kept in another system')
  await page.getByRole('button', { name: 'Delete tracker', exact: true }).click()
  const cards = page.getByRole('list', { name: 'Trackers' })
  await expect(cards).toBeVisible()
  await expect(cards).not.toContainText('RISK')
  await restore(page, project, 'RISK Risk Assessment')
  await page.getByRole('link', { name: 'Trackers' }).click()
  await expect(cards).toContainText('RISK')

  await page.getByRole('link', { name: 'Trash' }).click()
  await expect(page.getByText('The trash is empty.')).toBeVisible()
})
