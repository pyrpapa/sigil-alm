import { test, expect } from '@playwright/test'

// CSV import and item links. Creates data, so it runs only against the throwaway
// CI database (E2E_ALLOW_WRITES=true).
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

const SRS_CSV = `id,folder,title,requirement,verification,rationale,status
SRS-001,Access,Sign-in required,"Users sign in
before seeing data.",Test (automated),Identified users only.,Draft
SRS-002,Access,Project access,Members see only their projects.,Test (automated),,Draft
`
const RISK_CSV = `id,title,linked_srs,failure_mode,severity,likelihood,risk_level,status
RISK-001,Access beyond role,SRS-001; SRS-002,A user reads another project.,H,M,High,Draft
`
const csv = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

test('CSV import with preview, then links on both items', { tag: ['@SRS-019', '@SRS-047'] }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')
  const projectName = `E2E Links ${Date.now()}`
  await signIn(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(projectName)
  await page.getByRole('button', { name: 'Create project' }).click()
  await page.getByRole('link', { name: projectName }).click()
  const trackers = `${page.url().replace(/\/$/, '')}/trackers`

  // Import SRS: the preview creates nothing until confirmed
  await page.goto(`${trackers}/SRS`)
  await page.getByRole('link', { name: 'Import CSV' }).click()
  await page.getByLabel('Choose a CSV file').setInputFiles(csv('srs.csv', SRS_CSV))
  await expect(page.getByRole('status')).toContainText('All 2 rows are valid')
  await expect(page.getByRole('table', { name: 'Import preview' })).toContainText('SRS-002')
  await page.getByRole('button', { name: 'Import 2 items' }).click()
  await expect(page.getByRole('status')).toContainText('Imported 2 items')

  // Import RISK with links to both requirements
  await page.goto(`${trackers}/RISK/import`)
  await page.getByLabel('Choose a CSV file').setInputFiles(csv('risk.csv', RISK_CSV))
  await page.getByRole('button', { name: 'Import 1 items' }).click()
  await expect(page.getByRole('status')).toContainText('Imported 1 items')

  // The link shows on the requirement, phrased from its side
  await page.goto(`${trackers}/SRS/SRS-001`)
  const srsLinks = page.getByRole('region', { name: 'Links' })
  await expect(srsLinks).toContainText('SRS-001 mitigates')
  await expect(srsLinks.getByRole('link', { name: 'RISK-001' })).toBeVisible()

  // Remove one link from the risk: a new version, shown in history
  await page.goto(`${trackers}/RISK/RISK-001`)
  const links = page.getByRole('region', { name: 'Links' })
  await links.locator('.link-row', { hasText: 'SRS-002' }).getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Remove link' }).click()
  await expect(links.locator('.link-row', { hasText: 'SRS-002' })).toHaveCount(0)
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByRole('table', { name: 'Item history' })).toContainText('Link removed: is mitigated by SRS-002')
})
