import { createClient } from '@supabase/supabase-js'

export type Theme = { id: string; name: string; description: string | null }
export type Settings = { title: string; description: string; voting_enabled: boolean; leaderboard_visible: boolean }
export type Ranking = Theme & { rank: number; rating: number; wins: number; losses: number; comparisons: number; win_percentage: number; active: boolean }
export type Results = { total_votes: number; refreshed_at: string; rankings: Ranking[] }

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const configured = Boolean(url && key && !url.includes('your-project') && !key.includes('your-public'))
const client = configured ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null

export class RpcError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = 'RpcError' }
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!client) throw new Error('Connect Supabase to open voting. See the setup instructions in the README.')
  const { data, error } = await client.rpc(name, args).abortSignal(AbortSignal.timeout(15000))
  if (error) throw new RpcError(error.message, error.code)
  return data as T
}

export const api = {
  settings: () => rpc<Settings>('get_settings'),
  pair: (session: string, history: string[]) => rpc<Theme[]>('get_pair', { p_session_id: session, p_recent_pairs: history }),
  vote: (pair: Theme[], winner: string, session: string, request: string) => rpc<{ success: boolean }>('submit_vote', {
    p_item_a_id: pair[0].id, p_item_b_id: pair[1].id, p_winner_id: winner, p_session_id: session, p_request_id: request,
  }),
  results: () => rpc<Results>('get_leaderboard'),
}
