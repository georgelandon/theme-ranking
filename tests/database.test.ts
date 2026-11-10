import { PGlite } from '@electric-sql/pglite'
import { Pool, type PoolClient } from 'pg'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../supabase/migrations/202611090001_initial.sql', import.meta.url), 'utf8')
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
const session = () => crypto.randomUUID()
const url = process.env.TEST_DATABASE_URL

describe('database API and privacy', () => {
  let db: PGlite | Pool
  let connection: PoolClient | undefined
  const sql = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) => {
    // SET ROLE is connection-local. pool.query releases (and on an expected
    // permission error destroys) its connection, losing the role for the next
    // assertion. Keep one checked-out client for all stateful test queries.
    const result = await (connection ?? db).query(query, params)
    return result.rows as T[]
  }
  const vote = (a = A, b = B, winner = A, participant = session(), request = session()) =>
    sql('select public.submit_vote($1,$2,$3,$4,$5) as result', [a, b, winner, participant, request])

  beforeAll(async () => {
    db = url ? new Pool({ connectionString: url, max: 24 }) : new PGlite()
    if (db instanceof Pool) connection = await db.connect()
    // Use ONLY a disposable test database. Never point TEST_DATABASE_URL at production.
    const bootstrap = `drop schema public cascade; create schema public;
      do $$ begin if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
      grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated;`
    if (db instanceof PGlite) { await db.exec(bootstrap); await db.exec(migration) }
    else { await connection!.query(bootstrap); await connection!.query(migration) }
  })
  beforeEach(async () => {
    await sql('truncate public.votes, public.items;')
    await sql("update public.competition_settings set voting_enabled = true, leaderboard_visible = false where id = 1")
    await sql('insert into public.items (id,name) values ($1, $2),($3,$4),($5,$6)', [A, 'Time Loop', B, 'Hidden Worlds', C, 'Gravity'])
  })
  afterEach(async () => { await sql('reset role') })
  afterAll(async () => {
    if (db instanceof PGlite) await db.close()
    else { connection?.release(); await db.end() }
  })

  it('defaults to open voting and private results', async () => {
    expect((await sql<{ s: Record<string, unknown> }>('select public.get_settings() s'))[0].s).toMatchObject({ voting_enabled: true, leaderboard_visible: false })
    await expect(sql('select public.get_leaderboard()')).rejects.toThrow(/Results will be available/)
  })

  it('revokes direct table access and privileged functions even with Supabase-style defaults', async () => {
    for (const role of ['anon', 'authenticated']) {
      await sql(`set role ${role}`)
      for (const table of ['items', 'votes', 'competition_settings']) {
        for (const query of [`select * from public.${table}`, `delete from public.${table}`, `update public.${table} set id = id`]) {
          await expect(sql(query)).rejects.toThrow(/permission denied/)
          expect((await sql<{ role: string }>('select current_user as role'))[0].role).toBe(role)
        }
      }
      await expect(sql("insert into public.items(name) values ('Injected')")).rejects.toThrow(/permission denied/)
      await expect(sql('select public.recompute_ratings()')).rejects.toThrow(/permission denied/)
      await expect(sql('select public.get_leaderboard()')).rejects.toThrow(/Results will be available/)
      const themes = await sql<{ name: string; id: string; description: string }>('select * from public.get_themes()')
      expect(Object.keys(themes[0]).sort()).toEqual(['description', 'id', 'name'])
      await expect(vote()).resolves.toEqual([{ result: { success: true } }])
      await sql('reset role')
    }
  })

  it('updates Elo and both counters atomically without returning ratings', async () => {
    expect(await vote()).toEqual([{ result: { success: true } }])
    const rows = await sql<{ rating: string; wins: number; losses: number; comparisons: number }>('select rating,wins,losses,comparisons from public.items where id in ($1,$2) order by id', [A, B])
    expect(Number(rows[0].rating)).toBe(1516)
    expect(Number(rows[1].rating)).toBe(1484)
    expect(rows.map(({ rating: _, ...r }) => r)).toEqual([{ wins: 1, losses: 0, comparisons: 1 }, { wins: 0, losses: 1, comparisons: 1 }])
  })

  it('uses fractional expected scores and conserves total rating', async () => {
    await sql('update public.items set rating = 1700 where id = $1', [A])
    await vote(A, B, B)
    const rows = await sql<{ rating: string }>('select rating from public.items where id in ($1,$2) order by id', [A, B])
    expect(Number(rows[0].rating)).toBeCloseTo(1700 - 32 / (1 + 10 ** (-200 / 400)), 8)
    expect(Number(rows[0].rating) + Number(rows[1].rating)).toBeCloseTo(3200, 8)
  })

  it('rejects invalid votes and leaves all data unchanged', async () => {
    await expect(vote(A, A)).rejects.toThrow(/Invalid/)
    await expect(vote(A, B, C)).rejects.toThrow(/Invalid/)
    await expect(vote(A, session())).rejects.toThrow(/exist and be active/)
    await sql('update public.items set active = false where id = $1', [B])
    await expect(vote()).rejects.toThrow(/exist and be active/)
    await sql('update public.competition_settings set voting_enabled = false')
    await expect(vote(A, C)).rejects.toThrow(/closed/)
    expect((await sql<{ n: number }>('select count(*)::int n from public.votes'))[0].n).toBe(0)
    expect((await sql<{ n: number }>('select sum(comparisons)::int n from public.items'))[0].n).toBe(0)
  })

  it('makes retries idempotent, rejects changed requests, and rate-limits sessions', async () => {
    const participant = session(), request = session()
    await vote(A, B, A, participant, request)
    await vote(A, B, A, participant, request)
    await expect(vote(A, B, B, participant, request)).rejects.toThrow(/already used/)
    await expect(vote(A, C, A, participant)).rejects.toThrow(/wait a moment/)
    expect((await sql<{ n: number }>('select count(*)::int n from public.votes'))[0].n).toBe(1)
  })

  it('returns only safe theme fields, avoids recent pairs, and falls back after exhaustion', async () => {
    const participant = session()
    const get = async (recent: string[] = []) => (await sql<{ pair: { id: string; name: string; description: string | null }[] }>('select public.get_pair($1,$2::jsonb) pair', [participant, JSON.stringify(recent)]))[0].pair
    let history: string[] = []
    for (let i = 0; i < 3; i++) {
      const pair = await get(history)
      expect(pair).toHaveLength(2)
      expect(Object.keys(pair[0]).sort()).toEqual(['description', 'id', 'name'])
      const key = pair.map(p => p.id).sort().join(':')
      expect(history).not.toContain(key)
      history.push(key)
    }
    expect(await get(history)).toHaveLength(2)
    await sql('update public.items set active = false where id <> $1', [A])
    expect(await get()).toEqual([])
  })

  it('respects stored session history and closed voting during pairing', async () => {
    const participant = session()
    await vote(A, B, A, participant)
    for (let i = 0; i < 5; i++) {
      const pair = (await sql<{ p: { id: string }[] }>('select public.get_pair($1) p', [participant]))[0].p
      expect(pair.map(p => p.id).sort().join(':')).not.toBe(`${A}:${B}`)
    }
    await sql('update public.competition_settings set voting_enabled = false')
    expect((await sql<{ p: unknown[] }>('select public.get_pair($1) p', [participant]))[0].p).toEqual([])
  })

  it('rejects malformed or unbounded pairing history', async () => {
    await expect(sql('select public.get_pair($1,$2)', [session(), '{}'])).rejects.toThrow(/array/)
    await expect(sql('select public.get_pair($1,$2)', [session(), JSON.stringify(Array(51).fill('x'))])).rejects.toThrow(/at most 50/)
  })

  it('reveals consistent rankings, shared tie ranks, zero percentages and totals only when unlocked', async () => {
    await vote()
    await sql('update public.items set rating = 1516 where id = $1', [C])
    await sql('update public.competition_settings set voting_enabled = false, leaderboard_visible = true')
    await sql('set role anon')
    const result = (await sql<{ r: { total_votes: number; rankings: { rank: number; rating: number; win_percentage: number }[] } }>('select public.get_leaderboard() r'))[0].r
    expect(result.total_votes).toBe(1)
    expect(result.rankings.map(r => r.rank)).toEqual([1, 1, 2])
    expect(result.rankings[0].win_percentage).toBe(0)
    await sql('reset role')
    await sql('update public.competition_settings set leaderboard_visible = false')
    await expect(sql('select public.get_leaderboard()')).rejects.toThrow(/Results will be available/)
  })

  it('replays history deterministically, including disabled themes, without changing vote records', async () => {
    await vote(A, B, A)
    await vote(B, C, C)
    await vote(A, C, C)
    const before = await sql('select id,rating,wins,losses,comparisons from public.items order by id')
    await sql('update public.items set rating = 99, active = false')
    await sql('select public.recompute_ratings()')
    expect(await sql('select id,rating,wins,losses,comparisons from public.items order by id')).toEqual(before)
    expect((await sql<{ n: number }>('select count(*)::int n from public.votes'))[0].n).toBe(3)
  })

  it('enforces case-insensitive uniqueness and vote constraints for administrator writes', async () => {
    await expect(sql("insert into public.items(name) values ('TIME LOOP')")).rejects.toThrow(/duplicate/)
    await expect(sql('insert into public.votes(item_a_id,item_b_id,winner_id,session_id) values ($1,$1,$1,$2)', [A, session()])).rejects.toThrow(/check constraint/)
  })

  it.skipIf(!url)('handles concurrent crossed pairs without lost updates or deadlocks (real PostgreSQL)', async () => {
    // Deliberately use the pool here: a checked-out client would serialize the
    // queries in Node and would not exercise PostgreSQL's concurrent row locks.
    const pool = db as Pool
    await Promise.all(Array.from({ length: 30 }, (_, i) => {
      const [a, b, winner] = i % 3 === 0 ? [A, B, A] : i % 3 === 1 ? [B, C, B] : [C, A, C]
      return pool.query('select public.submit_vote($1,$2,$3,$4,$5)', [a, b, winner, session(), session()])
    }))
    const rows = await sql<{ wins: number; losses: number; comparisons: number; rating: string }>('select * from public.items')
    expect(rows.reduce((n, r) => n + r.comparisons, 0)).toBe(60)
    expect(rows.reduce((n, r) => n + r.wins, 0)).toBe(30)
    expect(rows.reduce((n, r) => n + r.losses, 0)).toBe(30)
    expect(rows.reduce((n, r) => n + Number(r.rating), 0)).toBeCloseTo(4500, 7)
    const before = await sql('select id,rating,wins,losses,comparisons from public.items order by id')
    await sql('select public.recompute_ratings()')
    expect(await sql('select id,rating,wins,losses,comparisons from public.items order by id')).toEqual(before)
  })
})
