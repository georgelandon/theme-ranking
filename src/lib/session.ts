export const pairKey = (a: string, b: string) => [a, b].sort().join(':')

export function createParticipant(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined) {
  let session: string | null = null
  try { session = storage?.getItem('theme-vote:session') ?? null } catch { /* Private browsing fallback. */ }
  if (!session || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session)) {
    session = crypto.randomUUID()
    try { storage?.setItem('theme-vote:session', session) } catch { /* Keep a stable in-memory ID. */ }
  }
  return session
}

export function rememberPair(history: string[], a: string, b: string) {
  const key = pairKey(a, b)
  return [...history.filter(p => p !== key), key].slice(-50)
}
