import { describe, expect, it } from 'vitest'
import { createParticipant, pairKey, rememberPair } from '../src/lib/session'

describe('participant and comparison history', () => {
  it('persists a cryptographic UUID across visits', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) } }
    const id = createParticipant(storage)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(createParticipant(storage)).toBe(id)
  })
  it('handles blocked storage and replaces corrupt IDs', () => {
    expect(createParticipant({ getItem: () => { throw Error() }, setItem: () => { throw Error() } })).toHaveLength(36)
    expect(createParticipant({ getItem: () => 'corrupted', setItem: () => {} })).not.toBe('corrupted')
  })
  it('canonicalizes, deduplicates, and bounds recent history including skipped pairs', () => {
    expect(pairKey('b', 'a')).toBe('a:b')
    const history = Array.from({ length: 50 }, (_, i) => `${i}:x`)
    const next = rememberPair(history, 'y', 'z')
    expect(next).toHaveLength(50)
    expect(next[0]).toBe('1:x')
    expect(rememberPair(next, 'z', 'y')).toEqual(next)
  })
})
