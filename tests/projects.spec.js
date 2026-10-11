import { test, expect } from '@playwright/test'

// Tests that create data run only against the throwaway database in CI
// (E2E_ALLOW_WRITES=true), never against the real Supabase project.
const writesAllowed = process.env.E2E_ALLOW_WRITES === 'true'

test('user can create a project with planned dates', { tag: '@SRS-009' }, async ({ page }) => {
  test.skip(!writesAllowed, 'Creates data: runs only against the throwaway CI database')

  await page.goto('/login')
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()

  const name = `E2E Project ${Date.now()}`
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill(name)
  await page.getByLabel('System under validation').fill('Sigil v1.0')
  await page.getByLabel('Planned start').fill('2026-11-02')
  await page.getByLabel('Planned end').fill('2026-12-18')
  await page.getByRole('button', { name: 'Create project' }).click()

  const project = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: name })
  await expect(project).toBeVisible()
  await expect(project).toContainText('Sigil v1.0')
  await expect(project).toContainText('planning')

  // Still there after a reload: it was saved, not just shown
  await page.reload()
  await expect(page.getByRole('list', { name: 'Projects' }).getByText(name)).toBeVisible()
})
