import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
// @ts-expect-error Node script is deliberately importable without a transpilation step.
import { generateSeed } from '../scripts/generate-seed.mjs'

describe('theme import', () => {
  it('trims, deduplicates, and handles empty files', () => {
    const sql = generateSeed(' Time Loop \r\n\nTIME LOOP\nGravity\n')
    expect(sql.match(/1500/g)).toHaveLength(2)
    expect(generateSeed('\n  ')).toBe('-- No themes to import.\n')
    expect(() => generateSeed('bad\0name')).toThrow(/NUL/)
  })
  it('escapes quotes and backslashes and preserves existing ratings and history on repeated imports', async () => {
    const db = new PGlite()
    try {
      await db.exec("create role anon; create role authenticated;")
      await db.exec(readFileSync(new URL('../supabase/migrations/202611090001_initial.sql', import.meta.url), 'utf8'))
      const names = "Devil's Advocate\nC:\\Worlds\n'); drop table public.items; --"
      await db.exec(generateSeed(names))
      await db.exec("update public.items set rating = 1600 where name = 'C:\\Worlds'")
      await db.exec(generateSeed(names + '\nGravity'))
      const rows = await db.query<{ name: string; rating: string }>('select name,rating from public.items')
      expect(rows.rows).toHaveLength(4)
      expect(Number(rows.rows.find(r => r.name === 'C:\\Worlds')?.rating)).toBe(1600)
      expect(rows.rows.map(r => r.name)).toContain("'); drop table public.items; --")
    } finally { await db.close() }
  })
})
