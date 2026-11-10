import { useCallback, useEffect, useRef, useState } from 'react'
import { api, configured, RpcError, type Results, type Settings, type Theme } from './lib/api'
import { createParticipant, rememberPair } from './lib/session'

const defaults: Settings = { title: 'Game Jam Theme Vote', description: 'Which theme would make a better game?', voting_enabled: true, leaderboard_visible: false }
const message = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.'
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function Spark({ small = false }: { small?: boolean }) {
  return <svg width={small ? 20 : 28} height={small ? 20 : 28} viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 2l3.7 10.3L30 16l-10.3 3.7L16 30l-3.7-10.3L2 16l10.3-3.7L16 2Z" fill="currentColor" /></svg>
}

function App() {
  const [route, setRoute] = useState(location.hash === '#/results' ? 'results' : 'vote')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [session] = useState(() => { let storage: Storage | undefined; try { storage = localStorage } catch { /* Use memory. */ } return createParticipant(storage) })

  const refreshSettings = useCallback(async () => {
    if (!configured) return
    try { const next = await api.settings(); if (!next) throw new Error('Competition settings are missing.'); setSettings(next); setSettingsError('') }
    catch (e) { setSettingsError(message(e)) }
  }, [])

  useEffect(() => {
    const navigate = () => setRoute(location.hash === '#/results' ? 'results' : 'vote')
    const focus = () => { void refreshSettings() }
    window.addEventListener('hashchange', navigate)
    window.addEventListener('focus', focus)
    const timer = window.setInterval(focus, 20000)
    void refreshSettings()
    return () => { clearInterval(timer); window.removeEventListener('hashchange', navigate); window.removeEventListener('focus', focus) }
  }, [refreshSettings])

  const current = settings ?? defaults
  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="#/" aria-label="Game Jam Theme Vote home"><span className="brand-icon"><Spark /></span><span>JAM<span className="brand-light"> / </span>COLLECTIVE<span className="brand-caption">GOOD GAMES START WITH AN IDEA.</span></span></a>
      <nav aria-label="Main navigation"><a href="#/" className={route === 'vote' ? 'nav-active' : ''}>Theme vote</a>{current.leaderboard_visible && settings && <a href="#/results" className={route === 'results' ? 'nav-active' : ''}>Results <span aria-hidden="true">↗</span></a>}</nav>
      <span className="header-note"><span className="tiny-star">✳</span> A little inspiration. A lot of possibility.</span>
    </header>

    <main id="main-content">
      {settingsError && <div className="connection-error" role="alert">Couldn’t refresh competition: {settingsError} <button onClick={() => void refreshSettings()}>Try again</button></div>}
      {route === 'results' ? <Leaderboard visible={Boolean(settings?.leaderboard_visible)} checking={configured && !settings && !settingsError} refreshSettings={refreshSettings} /> : <>
        <section className="intro">
          <div className="eyebrow"><span className="section-line" /> THE NEXT GREAT GAME STARTS HERE</div>
          <div className="title-row"><h1>{current.title === defaults.title ? <>Game Jam<br /><span>Theme Vote<span className="title-dot">.</span></span></> : current.title}</h1><div className="hero-sticker" aria-hidden="true"><Spark /><span>SMALL IDEA.<br />BIG POTENTIAL.</span><span className="sticker-arrow">↙</span></div></div>
          <p className="intro-copy">Two themes. One choice. Help shape what we make next.</p>
        </section>
        {!configured ? <section className="state-panel"><span className="state-icon">↗</span><h2>A great jam is on the way.</h2><p>Connect your Supabase project to open the voting room.</p><p className="muted">Add the public environment variables in <code>.env</code> and follow the README to set up your competition.</p></section>
          : !settings ? <section className="state-panel" aria-busy={!settingsError}><h2>{settingsError ? 'The voting room is taking a moment.' : 'Opening the voting room…'}</h2><p>We’ll have your next choice ready shortly.</p></section>
          : !settings.voting_enabled ? <section className="state-panel"><span className="state-icon"><Spark /></span><p className="eyebrow">THAT’S A WRAP</p><h2>Voting Has Concluded</h2><p>Thank you for participating in the Game Jam Theme Vote.</p>{settings.leaderboard_visible ? <a className="primary-button" href="#/results">Discover the results <span>↗</span></a> : <p className="muted">Results will be announced soon.</p>}</section>
          : <Voting session={session} settings={settings} refreshSettings={refreshSettings} />}
        <section className="how-it-works" aria-label="How it works"><div><span className="step-number">01</span><h3>Go with your gut.</h3><p>Pick the theme you’d love to build a game around.</p></div><div><span className="step-number">02</span><h3>Keep the ideas flowing.</h3><p>Every choice helps. Vote as many times as you like.</p></div><div><span className="step-number">03</span><h3>Let the reveal surprise you.</h3><p>Rankings stay hidden until the results are revealed.</p></div></section>
      </>}
    </main>
    <footer><span><Spark small /> MADE FOR CURIOUS MINDS & GAME MAKERS.</span><span>No accounts. Just opinions.<span className="footer-dot">✳</span></span></footer>
  </div>
}

function Voting({ session, settings, refreshSettings }: { session: string; settings: Settings; refreshSettings: () => Promise<void> }) {
  const [pair, setPair] = useState<Theme[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [notice, setNotice] = useState('')
  const history = useRef<string[]>([])
  const lock = useRef(false)
  const mounted = useRef(false)
  const pending = useRef<{ winner: string; request: string } | null>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  const load = useCallback(async () => {
    const next = await api.pair(session, history.current)
    if (!mounted.current) return
    setPair(next)
    if (next.length === 2) history.current = rememberPair(history.current, next[0].id, next[1].id)
  }, [session])

  useEffect(() => {
    mounted.current = true
    void load().catch(e => { if (mounted.current) setError(message(e)) }).finally(() => { if (mounted.current) setBusy(false) })
    return () => { mounted.current = false }
  }, [load])

  const advance = async (winner?: string) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    const restoreFocus = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('.comparison-area')
    try {
      if (winner) {
        const submission = pending.current ?? { winner, request: crypto.randomUUID() }
        pending.current = submission
        await api.vote(pair, submission.winner, session, submission.request)
        pending.current = null
        if (!mounted.current) return
        setSelected(submission.winner); setCount(n => n + 1); setNotice('Choice saved. You’re shaping the jam!')
        await wait(850)
      }
      await load()
    } catch (e) {
      if (mounted.current) {
        // A PostgreSQL exception definitively rolled back the transaction. Network
        // failures remain uncertain and keep their request ID for a safe retry.
        if (e instanceof RpcError && /^(P\d{4}|22\w{3}|23\w{3}|42501)$/.test(e.code)) {
          pending.current = null
          setPair([])
        }
        setError(message(e)); await refreshSettings()
      }
    } finally {
      if (mounted.current) { setSelected(null); setBusy(false); lock.current = false; if (restoreFocus) requestAnimationFrame(() => buttons.current[0]?.focus()) }
    }
  }

  return <section className="voting-section" aria-label="Choose a theme">
    <div className="comparison-heading"><div><span className="live-pill"><span /> VOTING IS OPEN</span><h2>{settings.description}</h2></div><span className="session-count"><strong>{String(count).padStart(2, '0')}</strong> choices this visit</span></div>
    <div className="comparison-area" aria-busy={busy}>
      {pair.length === 2 ? <><div className="theme-grid">{pair.map((theme, i) => <button key={theme.id} ref={el => { buttons.current[i] = el }} className={`theme-card card-${i} ${selected === theme.id ? 'is-selected' : ''}`} disabled={busy || Boolean(pending.current)} onClick={() => void advance(theme.id)} aria-label={`Vote for ${theme.name}`}>
        <div className="card-topline"><span>THEME {i === 0 ? 'A' : 'B'}</span><span className="card-direction" aria-hidden="true">↗</span></div>
        <div className={`theme-art art-${i}`} aria-hidden="true">{i === 0 ? <><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-core"><Spark /></div><span className="art-spark spark-one">✳</span><span className="art-spark spark-two">+</span><span className="art-label">IMAGINE THE POSSIBILITIES</span></> : <><div className="portal portal-one" /><div className="portal portal-two" /><div className="portal portal-three" /><span className="art-spark spark-one">✦</span><span className="art-spark spark-two">+</span><span className="art-label">MAKE SOMETHING UNEXPECTED</span></>}</div>
        <div className="theme-text"><h3>{theme.name}</h3>{theme.description && <p>{theme.description}</p>}<span className="choose-label">{selected === theme.id ? '✓ Choice saved' : 'I’d make a game about this'} <span aria-hidden="true">→</span></span></div>
      </button>)}</div><div className="versus" aria-hidden="true">VS</div></>
        : <div className="empty-pair"><Spark /><h3>{busy ? 'Finding your next two ideas…' : error ? 'Your next ideas are taking a moment.' : 'Good things need a pair.'}</h3><p>{!busy && !error ? 'There aren’t two active themes yet. Check back soon.' : 'A fresh dose of inspiration is on its way.'}</p></div>}
    </div>
    <div className="voting-controls"><span className="keyboard-hint"><kbd>Tab</kbd> to explore <span>·</span> <kbd>Enter</kbd> to choose</span><button className="skip-button" disabled={busy || Boolean(pending.current)} onClick={() => void advance()}>Can’t decide? <strong>Skip this pair <span aria-hidden="true">↪</span></strong></button></div>
    <div className="feedback" aria-live="polite" role="status">{busy && !selected ? 'Preparing your next choice…' : notice}</div>
    {error && <div className="error-panel" role="alert"><p>{error}</p><button onClick={() => void advance(pending.current?.winner)} disabled={busy}>{pending.current ? 'Retry the same vote' : 'Try another pair'}</button>{pending.current && <small>Your vote may have reached the database. Retrying uses the same request ID so it is counted only once.</small>}</div>}
    <div className="privacy-note"><span aria-hidden="true">◈</span> Your picks count. The rankings stay a mystery.<span className="privacy-lock">RESULTS UNDER WRAPS</span></div>
  </section>
}

function Leaderboard({ visible, checking, refreshSettings }: { visible: boolean; checking: boolean; refreshSettings: () => Promise<void> }) {
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++generation.current
    setResults(null); setBusy(true); setError('')
    try { const data = await api.results(); if (token === generation.current) setResults(data) }
    catch (e) { if (token === generation.current) setError(message(e)); await refreshSettings() }
    finally { if (token === generation.current) setBusy(false) }
  }, [refreshSettings])
  useEffect(() => { if (visible) void refresh(); else { generation.current++; setResults(null) } return () => { generation.current++ } }, [visible, refresh])
  const winners = results?.rankings.filter(r => r.rank === 1) ?? []
  return <section className="results-page"><a className="back-link" href="#/">← Back to Voting</a><div className="eyebrow">THE COLLECTIVE HAS SPOKEN</div><h1>The big reveal<span className="title-dot">.</span></h1>
    {!visible ? <div className="state-panel"><span className="state-icon">◈</span><h2>{checking ? 'Checking the results room…' : 'A little mystery remains.'}</h2><p>Results will be available when voting concludes.</p></div> : <>
      <div className="results-toolbar"><p>{results ? <><strong>{results.total_votes.toLocaleString()}</strong> votes. One community.</> : 'Every choice helped shape these results.'}</p><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh Results ↻'}</button></div>
      {error && <div className="error-panel" role="alert">{error}</div>}
      {busy && <p role="status">Gathering the results…</p>}
      {results && (results.total_votes === 0 ? <div className="state-panel"><h2>A blank canvas, for now.</h2><p>No votes have been recorded yet.</p></div> : <>
        <div className="winner-card"><div><span className="eyebrow">{winners.length > 1 ? 'JOINT WINNERS' : 'THE WINNER'} / COMMUNITY’S CHOICE</span><h2>{winners.map(w => w.name).join(' & ')}</h2><p>{winners.map(w => `${w.name}: ${Number(w.rating).toFixed(0)} Elo · ${w.comparisons} comparisons`).join(' / ')}</p></div><span className="winner-spark"><Spark /></span></div>
        <h2 className="table-heading">The complete rankings</h2><div className="table-scroll" tabIndex={0} role="region" aria-label="Complete theme rankings, scroll horizontally for all columns"><table><thead><tr>{['Rank', 'Theme', 'Elo rating', 'Wins', 'Losses', 'Comparisons', 'Win %'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{results.rankings.map(r => <tr key={r.id} className={r.rank === 1 ? 'first-place' : ''}><td>{String(r.rank).padStart(2, '0')}</td><th scope="row">{r.name}{!r.active && <small>Inactive</small>}</th><td>{Number(r.rating).toFixed(0)}</td><td>{r.wins}</td><td>{r.losses}</td><td>{r.comparisons}</td><td>{Number(r.win_percentage).toFixed(1)}%</td></tr>)}</tbody></table></div>
      </>)}
      {results && <p className="last-refresh">Last refreshed {new Date(results.refreshed_at).toLocaleString()}. Equal ratings share a rank.</p>}
    </>}
  </section>
}

export default App
