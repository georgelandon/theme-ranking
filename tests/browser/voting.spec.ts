import { test, expect } from '@playwright/test'

test('voting, keyboard controls, closed voting and a controlled results reveal', async ({ page }, testInfo) => {
  const settings = { title: 'Game Jam Theme Vote', description: 'Which theme would make a better game?', voting_enabled: true, leaderboard_visible: false }
  const themes = [{ id: 'a', name: 'Time Loop', description: null }, { id: 'b', name: 'Parallel Universes', description: null }]
  let votes = 0
  let pairs = 0
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('https://browser-test.supabase.co/**', async route => {
    const fn = route.request().url().split('/').at(-1)
    let json: unknown
    if (fn === 'get_settings') json = settings
    else if (fn === 'get_pair') { pairs++; json = themes }
    else if (fn === 'submit_vote') { votes++; json = { success: true } }
    else if (fn === 'get_leaderboard') json = { total_votes: votes, refreshed_at: '2026-11-10T01:00:00Z', rankings: themes.map((t, i) => ({ ...t, rank: i + 1, rating: i ? 1484 : 1516, wins: i ? 0 : 1, losses: i ? 1 : 0, comparisons: 1, win_percentage: i ? 0 : 100, active: true })) }
    else throw new Error(`Unexpected RPC ${fn}`)
    await route.fulfill({ json })
  })
  await page.goto('./')
  const first = page.getByRole('button', { name: 'Vote for Time Loop' })
  await expect(first).toBeEnabled()
  await expect(page.getByRole('link', { name: /Results/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Vote for/ })).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('voting.png'), fullPage: true })
  await first.focus()
  await page.keyboard.press('Enter')
  await expect(first).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Vote for Parallel Universes' })).toBeDisabled()
  await expect(first).toBeEnabled()
  expect(votes).toBe(1)
  const previous = pairs
  await page.getByRole('button', { name: /Skip this pair/ }).click()
  await expect.poll(() => pairs).toBeGreaterThan(previous)
  expect(votes).toBe(1)
  await page.goto('./#/results')
  await expect(page.getByText('Results will be available when voting concludes.')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  settings.voting_enabled = false
  await page.goto('./')
  await expect(page.getByText('Voting Has Concluded')).toBeVisible()
  await expect(page.getByText('Results will be announced soon.')).toBeVisible()
  settings.leaderboard_visible = true
  await page.reload()
  await page.getByRole('link', { name: /Discover the results/ }).click()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByText('100.0%')).toBeVisible()
  await page.getByRole('button', { name: /Refresh Results/ }).click()
  await expect(page.getByRole('table')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('results.png'), fullPage: true })
  if (testInfo.project.name === 'desktop') {
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  expect(errors).toEqual([])
})
