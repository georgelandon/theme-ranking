// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { api, RpcError, type Settings } from '../src/lib/api'

vi.mock('../src/lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/api')>(), configured: true, api: { settings: vi.fn(), pair: vi.fn(), vote: vi.fn(), results: vi.fn() } }))
const settings: Settings = { title: 'Game Jam Theme Vote', description: 'Which theme would make a better game?', voting_enabled: true, leaderboard_visible: false }
const pair = [{ id: 'a', name: 'Time Loop', description: null }, { id: 'b', name: 'Hidden Worlds', description: null }]

beforeEach(() => {
  location.hash = '#/'
  vi.mocked(api.settings).mockResolvedValue({ ...settings })
  vi.mocked(api.pair).mockResolvedValue(pair)
  vi.mocked(api.vote).mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('participant experience', () => {
  it('shows exactly two accessible theme cards and no private data or results link', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Vote for Time Loop' })
    expect(screen.getAllByRole('button', { name: /^Vote for/ })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: /Results/ })).toBeNull()
    expect(screen.queryByText(/1500|Elo|Wins|Losses/)).toBeNull()
  })
  it('disables both cards immediately, prevents rapid duplicate votes and advances after success', async () => {
    render(<App />)
    const card = await screen.findByRole('button', { name: 'Vote for Time Loop' })
    fireEvent.click(card); fireEvent.click(card)
    expect((card as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Vote for Hidden Worlds' }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(api.vote).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.pair).toHaveBeenCalledTimes(2), { timeout: 2500 })
    expect(screen.getByText(/choices this visit/).textContent).toContain('01')
  })
  it('skips without voting and includes skipped history in pairing requests', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Vote for Time Loop' })
    fireEvent.click(screen.getByRole('button', { name: /Skip this pair/ }))
    await waitFor(() => expect(api.pair).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.pair).mock.calls[1][1]).toEqual(['a:b'])
    expect(api.vote).not.toHaveBeenCalled()
  })
  it('retries an uncertain vote with the same idempotency key', async () => {
    vi.mocked(api.vote).mockRejectedValueOnce(new Error('Connection interrupted'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Vote for Time Loop' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry the same vote' }))
    await waitFor(() => expect(api.vote).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.vote).mock.calls[0]).toEqual(vi.mocked(api.vote).mock.calls[1])
  })
  it('closes voting on a settings refresh without redeployment', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'Vote for Time Loop' })
    vi.mocked(api.settings).mockResolvedValue({ ...settings, voting_enabled: false })
    fireEvent(window, new Event('focus'))
    await screen.findByText('Voting Has Concluded')
    expect(screen.getByText('Results will be announced soon.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Vote for/ })).toBeNull()
  })
  it('allows loading a fresh pair after the database rejects a disabled theme', async () => {
    vi.mocked(api.vote).mockRejectedValueOnce(new RpcError('Both themes must exist and be active.', 'P0001'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Vote for Time Loop' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try another pair' }))
    await screen.findByRole('button', { name: 'Vote for Time Loop' })
    expect(api.vote).toHaveBeenCalledTimes(1)
    expect(api.pair).toHaveBeenCalledTimes(2)
  })
  it('keeps direct results navigation locked without fetching rankings', async () => {
    location.hash = '#/results'
    render(<App />)
    await screen.findByText('Results will be available when voting concludes.')
    expect(api.results).not.toHaveBeenCalled()
  })
  it('handles too few themes gracefully', async () => {
    vi.mocked(api.pair).mockResolvedValue([])
    render(<App />)
    await screen.findByText('Good things need a pair.')
    expect(screen.getByText('There aren’t two active themes yet. Check back soon.')).toBeTruthy()
  })
  it('renders revealed results and clears them when visibility is revoked', async () => {
    location.hash = '#/results'
    vi.mocked(api.settings).mockResolvedValue({ ...settings, voting_enabled: false, leaderboard_visible: true })
    vi.mocked(api.results).mockResolvedValue({ total_votes: 1, refreshed_at: new Date().toISOString(), rankings: [
      { ...pair[0], rating: 1516, wins: 1, losses: 0, comparisons: 1, rank: 1, win_percentage: 100, active: true },
      { ...pair[1], rating: 1484, wins: 0, losses: 1, comparisons: 1, rank: 2, win_percentage: 0, active: true },
    ] })
    render(<App />)
    await screen.findByRole('table')
    expect(screen.getByText('100.0%')).toBeTruthy()
    vi.mocked(api.settings).mockResolvedValue({ ...settings, voting_enabled: false })
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull())
  })
  it('does not declare a winner when there are no votes', async () => {
    location.hash = '#/results'
    vi.mocked(api.settings).mockResolvedValue({ ...settings, voting_enabled: false, leaderboard_visible: true })
    vi.mocked(api.results).mockResolvedValue({ total_votes: 0, refreshed_at: new Date().toISOString(), rankings: [] })
    render(<App />)
    await screen.findByText('No votes have been recorded yet.')
    expect(screen.queryByRole('table')).toBeNull()
  })
})
