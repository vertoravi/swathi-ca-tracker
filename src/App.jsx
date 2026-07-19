import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { PAPERS, PLAN, RULES } from './data.js'
import { supabase } from './supabaseClient.js'

/* ============================================================
   PERSISTENCE LAYER — Supabase share-code sync + localStorage cache
   ------------------------------------------------------------
   The whole app state is one blob:
     { ch: {chapterKey:{done,hrs,conf,doneAt,hrsAt}}, mocks:[], why:"", mode:"full" }
   Sync model (no auth):
     - A share code identifies one saved blob. It comes from the
       ?code= URL param (for opening on another device) or from
       localStorage, or is generated on the entry screen.
     - Supabase table `progress` (share_code text PK, data jsonb,
       updated_at timestamptz) holds the blob. RLS scopes anon
       read/write to the matching share_code — the anon key is safe.
     - localStorage is the offline fallback / instant-render cache.
     - Writes are debounced ~800ms and are last-write-wins.
   Only this layer changed; the rest of the component is untouched.
   ============================================================ */
const LS_PREFIX = 'ca-final-g1-swathi-react-v1' // per-code cache: `${LS_PREFIX}:${code}`
const CODE_KEY = 'ca-final-g1-swathi-share-code'
const SAVE_DEBOUNCE = 800

function normalize(d) {
  return {
    ch: (d && d.ch) || {},
    mocks: (d && d.mocks) || [],
    secNotes: (d && d.secNotes) || {}, // { `${paper}-${si}`: text }
    why: (d && d.why) || '',
    mode: (d && d.mode) || 'full',
  }
}
const emptyState = () => normalize(null)

function lsKey(code) { return `${LS_PREFIX}:${code}` }
function loadLocal(code) {
  try {
    const r = localStorage.getItem(lsKey(code))
    if (r) return normalize(JSON.parse(r))
  } catch (e) {}
  return emptyState()
}
function saveLocal(code, s) {
  try { localStorage.setItem(lsKey(code), JSON.stringify(s)) } catch (e) {}
}

// Share-code helpers
function normCode(c) { return (c || '').trim().toUpperCase() }
function getInitialCode() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('code')
    if (fromUrl) {
      const c = normCode(fromUrl)
      if (c) { localStorage.setItem(CODE_KEY, c); return c }
    }
    return localStorage.getItem(CODE_KEY) || ''
  } catch (e) { return '' }
}
function genCode() {
  const A = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I to avoid confusion
  let s = ''
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]
  return 'SWA-' + s
}

/* ---------- constants + helpers ---------- */
const WA_NUMBER = '919885034568' // Swathi · +91 98850 34568
const EXAM = new Date('2026-11-02T00:00:00+05:30')
const DAY = 86400000
const daysLeft = () => Math.max(1, Math.ceil((EXAM - new Date()) / DAY))
const ck = (p, si, ci) => `${p}-${si}-${ci}`
const isToday = (ts) => {
  if (!ts) return false
  const d = new Date(ts), n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}
function reviseDue(st) {
  if (!st || !st.done || !st.doneAt) return null
  const age = (Date.now() - st.doneAt) / DAY
  if (st.conf === 3) { if (age >= 14) return 'overdue'; return null }
  if (age >= 7) return 'due'
  return null
}

export default function App() {
  const [code, setCode] = useState(getInitialCode)
  const [store, setStore] = useState(emptyState)
  const [status, setStatus] = useState('offline') // 'synced' | 'saving' | 'offline'
  const [ready, setReady] = useState(false)        // boot (initial load) complete
  const [syncErr, setSyncErr] = useState('')       // last sync error, for diagnostics
  const saveTimer = useRef(null)
  const configured = Boolean(supabase)             // env vars present at build time?

  const ch = store.ch || {}
  const mocks = store.mocks || []
  const mode = store.mode || 'full'

  const chooseCode = useCallback((c) => {
    const nc = normCode(c)
    if (!nc) return
    try { localStorage.setItem(CODE_KEY, nc) } catch (e) {}
    setCode(nc)
  }, [])

  // Log out of the current code → back to the entry screen (progress stays saved under the code).
  const switchCode = useCallback(() => {
    if (!window.confirm('Switch to a different code?\n\nYour current progress stays saved under this code — re-enter it anytime to get it back.')) return
    try { localStorage.removeItem(CODE_KEY) } catch (e) {}
    try { window.history.replaceState({}, '', window.location.pathname) } catch (e) {} // drop ?code= so it doesn't re-hydrate
    setReady(false)
    setStore(emptyState())
    setSyncErr('')
    setStatus('offline')
    setCode('')
  }, [])

  // Boot load: seed from local cache instantly, then pull latest from Supabase.
  useEffect(() => {
    if (!code) return
    let cancelled = false
    setReady(false)
    setStore(loadLocal(code))
    ;(async () => {
      if (!supabase) { setStatus('offline'); setSyncErr('not configured — Supabase env vars missing from this build'); if (!cancelled) setReady(true); return }
      try {
        const { data, error } = await supabase
          .from('progress').select('data').eq('share_code', code).maybeSingle()
        if (cancelled) return
        if (error) throw error
        if (data && data.data) {
          const remote = normalize(data.data)
          setStore(remote)
          saveLocal(code, remote)
        }
        setStatus('synced'); setSyncErr('')
      } catch (e) {
        if (!cancelled) { setStatus('offline'); setSyncErr(e?.message || 'fetch failed') }
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [code])

  // Persist on every change: localStorage immediately, Supabase debounced.
  useEffect(() => {
    if (!code || !ready) return
    saveLocal(code, store)
    if (!supabase) { setStatus('offline'); setSyncErr('not configured — Supabase env vars missing from this build'); return }
    setStatus('saving')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const { error } = await supabase
          .from('progress')
          .upsert({ share_code: code, data: store, updated_at: new Date().toISOString() })
        if (error) { setStatus('offline'); setSyncErr(error.message || 'save failed') }
        else { setStatus('synced'); setSyncErr('') }
      } catch (e) { setStatus('offline'); setSyncErr(e?.message || 'save failed') }
    }, SAVE_DEBOUNCE)
    return () => clearTimeout(saveTimer.current)
  }, [store, code, ready])

  const g = useCallback((k) => ch[k] || { done: false, hrs: 0, conf: 0, doneAt: null }, [ch])

  // active paper tab
  const [tab, setTab] = useState('fr')
  const [openSecs, setOpenSecs] = useState({}) // {paper: Set(si)}
  const [tick, setTick] = useState(0) // force countdown recompute if needed

  /* ---------- mutators ---------- */
  const updateChapter = (k, patch) => {
    setStore((s) => {
      const prev = s.ch?.[k] || { done: false, hrs: 0, conf: 0, doneAt: null }
      return { ...s, ch: { ...s.ch, [k]: { ...prev, ...patch } } }
    })
  }
  const toggleDone = (k) => {
    const cur = g(k)
    updateChapter(k, { done: !cur.done, doneAt: !cur.done ? Date.now() : null })
  }
  const setHours = (k, v) => updateChapter(k, { hrs: parseFloat(v) || 0, hrsAt: Date.now() })
  const setConf = (k, v) => {
    const cur = g(k)
    updateChapter(k, { conf: cur.conf === v ? 0 : v })
  }
  const setMode = (m) => {
    setStore((s) => ({ ...s, mode: m }))
    if (m === 'light' && ['mock', 'plan', 'how', 'res'].includes(tab)) setTab('fr')
  }
  const setWhy = (t) => setStore((s) => ({ ...s, why: t }))
  const setChNote = (k, t) => updateChapter(k, { note: t })
  const setSecNote = (pk, si, t) =>
    setStore((s) => ({ ...s, secNotes: { ...(s.secNotes || {}), [`${pk}-${si}`]: t } }))

  /* ---------- derived stats ---------- */
  const stats = useMemo(() => {
    let total = 0, done = 0, hrs = 0, shaky = 0, solid = 0, hiLeft = 0, revDue = 0
    const per = {}
    Object.keys(PAPERS).forEach((pk) => {
      let pt = 0, pd = 0
      PAPERS[pk].sections.forEach((s, si) =>
        s.ch.forEach((_, ci) => {
          const st = g(ck(pk, si, ci)); total++; pt++
          if (st.done) { done++; pd++ }
          hrs += st.hrs || 0
          if (st.conf === 1) shaky++
          if (st.conf === 3) solid++
          if (s.p === 'hi' && !st.done) hiLeft++
          if (reviseDue(st)) revDue++
        })
      )
      per[pk] = { pt, pd }
    })
    return { total, done, hrs, shaky, solid, hiLeft, revDue, per }
  }, [ch, g])

  /* ---------- study-now engine ---------- */
  const nextUp = useMemo(() => {
    const items = []
    Object.keys(PAPERS).forEach((pk) =>
      PAPERS[pk].sections.forEach((s, si) =>
        s.ch.forEach((name, ci) => {
          const st = g(ck(pk, si, ci))
          const wtScore = s.p === 'hi' ? 3 : s.p === 'med' ? 2 : 1
          let score = 0; const reasons = []
          if (!st.done) { score += wtScore * 4; reasons.push('not started') }
          if (st.conf === 1) { score += 8; reasons.push('rated shaky') }
          else if (st.conf === 2) { score += 2 }
          const rev = reviseDue(st)
          if (rev === 'due') { score += 5; reasons.push('revision due') }
          if (rev === 'overdue') { score += 3; reasons.push('revision overdue') }
          if (s.p === 'hi' && !st.done) score += 2
          if (score > 0) items.push({ pk, si, ci, name, tier: s.p, conf: st.conf, rev, score, reasons })
        })
      )
    )
    items.sort((a, b) => b.score - a.score)
    return items.slice(0, 4)
  }, [ch, g])

  /* ---------- pace ---------- */
  const pace = useMemo(() => {
    const remaining = stats.total - stats.done
    const d = daysLeft()
    const perDay = remaining / d
    const perWeek = perDay * 7
    let cls, label
    if (remaining === 0) { cls = 'ahead'; label = 'DONE ✓' }
    else if (perWeek <= 12) { cls = 'ahead'; label = 'Comfortable' }
    else if (perWeek <= 20) { cls = 'ontrack'; label = 'On track' }
    else { cls = 'behind'; label = 'Pick up pace' }
    return { remaining, d, perDay, perWeek, cls, label }
  }, [stats])

  /* ---------- encouragement / stall nudge ---------- */
  const encourage = useMemo(() => {
    let doneToday = 0, anyEver = false
    Object.keys(PAPERS).forEach((pk) =>
      PAPERS[pk].sections.forEach((s, si) =>
        s.ch.forEach((_, ci) => {
          const st = g(ck(pk, si, ci))
          if (st.doneAt || st.hrsAt) anyEver = true
          if (st.done && isToday(st.doneAt)) doneToday++
        })
      )
    )
    if (doneToday > 0) {
      const lines = [
        `${doneToday} chapter${doneToday > 1 ? 's' : ''} down today, that's real progress. Keep going, you've got this. 💛`,
        `Look at you, ${doneToday} today. Every tick is one less thing between you and November. 🌱`,
        `${doneToday} done today. Steady beats fast. Proud of you for showing up. ✨`,
      ]
      return { cls: 'encourage', em: '💛', text: lines[doneToday % lines.length] }
    }
    if (anyEver) {
      const now = Date.now(); let nudged = null
      ;['fr', 'afm', 'aud'].forEach((pk) => {
        let last = 0
        PAPERS[pk].sections.forEach((s, si) =>
          s.ch.forEach((_, ci) => {
            const st = g(ck(pk, si, ci))
            if (st.doneAt && st.doneAt > last) last = st.doneAt
            if (st.hrsAt && st.hrsAt > last) last = st.hrsAt
          })
        )
        if (last > 0) {
          const days = Math.floor((now - last) / DAY)
          if (days >= 4 && (!nudged || days > nudged.days)) nudged = { pk, days }
        }
      })
      if (nudged) {
        const nm = PAPERS[nudged.pk].name.split(',')[0]
        return { cls: 'encourage nudge', em: '🌤️', text: `${nm} has been quiet for ${nudged.days} days, no pressure, but maybe give it 20 minutes today? Small starts count. 💛` }
      }
    }
    return { cls: 'encourage', em: '🌅', text: `New day, fresh start. Pick one thing from "Study this next" and just begin, momentum follows. You've got this, Swathi. 💛` }
  }, [ch, g])

  /* ---------- WhatsApp daily update ---------- */
  const buildDailySummary = () => {
    let doneToday = [], hrsToday = 0, totalDone = 0, total = 0, shaky = 0, revDue = 0
    const perPaper = {}
    Object.keys(PAPERS).forEach((pk) => {
      perPaper[pk] = { done: 0, total: 0 }
      PAPERS[pk].sections.forEach((s, si) =>
        s.ch.forEach((name, ci) => {
          const st = g(ck(pk, si, ci)); total++; perPaper[pk].total++
          if (st.done) { totalDone++; perPaper[pk].done++ }
          if (isToday(st.doneAt) && st.done) doneToday.push(PAPERS[pk].name.split(',')[0] + ': ' + name)
          if (st.hrs && isToday(st.hrsAt)) hrsToday += st.hrs
          if (st.conf === 1) shaky++
          if (reviseDue(st)) revDue++
        })
      )
    })
    const d = daysLeft()
    const pct = total ? Math.round((totalDone / total) * 100) : 0
    const nu = nextUp.slice(0, 3).map((x) => x.name)
    let msg = `📚 *CA Final G1 · Daily Update*\n`
    msg += `_Swathi · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}_\n\n`
    msg += `✅ Done today: *${doneToday.length}* chapter${doneToday.length === 1 ? '' : 's'}\n`
    if (hrsToday > 0) msg += `⏱ Hours logged today: *${Math.round(hrsToday * 10) / 10}*\n`
    if (doneToday.length) {
      msg += doneToday.slice(0, 6).map((t) => `   • ${t}`).join('\n')
      if (doneToday.length > 6) msg += `\n   • +${doneToday.length - 6} more`
      msg += '\n'
    }
    msg += `\n📊 Overall: *${totalDone}/${total}* (${pct}%)\n`
    msg += `   FR ${perPaper.fr.done}/${perPaper.fr.total} · AFM ${perPaper.afm.done}/${perPaper.afm.total} · Audit ${perPaper.aud.done}/${perPaper.aud.total}\n`
    if (shaky) msg += `⚠️ Shaky chapters: *${shaky}*\n`
    if (revDue) msg += `🔁 Due to revise: *${revDue}*\n`
    msg += `⏳ *${d}* days to exam (Nov 2)\n`
    if (nu.length) {
      msg += `\n🎯 Tomorrow, start with:\n`
      msg += nu.map((n) => `   • ${n}`).join('\n') + '\n'
    }
    msg += `\n💪 *We GOT THIS.*`
    return msg
  }
  const sendWhatsApp = () => {
    const text = encodeURIComponent(buildDailySummary())
    window.open(`https://wa.me/${WA_NUMBER}?text=${text}`, '_blank')
  }

  /* ---------- export / import / reset ---------- */
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), student: 'Swathi', group: 'CA Final Group 1 Nov 2026', ...store }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'swathi-ca-final-g1-backup.json'; a.click()
  }
  const importJSON = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'
    inp.onchange = (e) => {
      const f = e.target.files[0]; if (!f) return
      const r = new FileReader()
      r.onload = () => {
        try {
          const d = JSON.parse(r.result)
          setStore({ ch: d.ch || {}, mocks: d.mocks || [], why: d.why || '', mode: d.mode || 'full' })
          alert('Backup restored.')
        } catch (err) { alert("Couldn't read that file.") }
      }
      r.readAsText(f)
    }
    inp.click()
  }
  const reset = () => {
    if (confirm('Reset ALL progress + mock scores for Swathi? Can\'t be undone.')) {
      setStore({ ch: {}, mocks: [], why: store.why, mode: store.mode })
    }
  }

  /* ---------- countdown values ---------- */
  const d = daysLeft(); const w = Math.floor(d / 7)

  const toggleSec = (pk, si) => {
    setOpenSecs((o) => {
      const set = new Set(o[pk] || [])
      set.has(si) ? set.delete(si) : set.add(si)
      return { ...o, [pk]: set }
    })
  }
  const jumpTo = (pk, si) => {
    setTab(pk)
    setOpenSecs((o) => ({ ...o, [pk]: new Set([...(o[pk] || []), si]) }))
    setTimeout(() => {
      const el = document.querySelector(`#sec-${pk}-${si}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
  }

  const isLight = mode === 'light'

  // Share-code entry screen (no code yet) — persistence gate only.
  if (!code) return <Gate onChoose={chooseCode} />

  const syncLabel = status === 'saving' ? 'saving…' : status === 'synced' ? 'synced ✓' : 'offline'
  const showDiag = () => {
    const lines = [
      `Sync code: ${code}`,
      `Status: ${status}`,
      `Supabase configured in this build: ${configured ? 'yes' : 'NO'}`,
    ]
    if (!configured) lines.push('', 'Fix: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel, then Redeploy.')
    if (syncErr) lines.push('', `Last error: ${syncErr}`)
    window.alert(lines.join('\n'))
  }

  return (
    <div className={isLight ? 'light' : ''}>
      <div className={`syncbadge ${status}`} title="Click for sync detail" onClick={showDiag}>{syncLabel}</div>
      <div className="wrap">
        {/* HEADER */}
        <header>
          <div className="banner">Swathi,<span className="we">We GOT THIS.</span></div>
          <div className="hero-sub">CA Final · <b>Group 1</b> · New Scheme · <b>Nov 2026</b> · FR · AFM · Advanced Auditing</div>
          <div className="countdown">
            <div className="cd"><div className="n">{d}</div><div className="l">Days to FR</div></div>
            <div className="cd"><div className="n">{w}</div><div className="l">Weeks left</div></div>
            <div className="cd"><div className="n">Nov 2</div><div className="l">Group 1 begins</div></div>
          </div>
          <div className="modebar">
            <div className="modeswitch">
              <button className={!isLight ? 'on' : ''} onClick={() => setMode('full')}>Full</button>
              <button className={isLight ? 'on' : ''} onClick={() => setMode('light')}>Light</button>
            </div>
          </div>
          <div className="wa-bar">
            <button className="wa-btn" onClick={sendWhatsApp}>📲 Send today's update to WhatsApp</button>
          </div>
        </header>

        {/* WHY ANCHOR */}
        <WhyAnchor why={store.why} onSave={setWhy} />

        {/* ENCOURAGEMENT */}
        <div className={encourage.cls}>
          <span className="em">{encourage.em}</span><span>{encourage.text}</span>
        </div>

        {/* STUDY NOW */}
        <div className="nextup">
          <h3>🎯 Study this next</h3>
          <div className="lead">Ranked by weightage × weakness × time left. Do these first, highest marks per hour.</div>
          <div className="nu-list">
            {nextUp.length === 0 ? (
              <div className="nu-empty">🎉 Nothing flagged, every chapter is done and solid. Now live in the Mock Scores tab.</div>
            ) : nextUp.map((it, i) => {
              const paperNm = PAPERS[it.pk].name.split(',')[0].split(' ').slice(0, 2).join(' ')
              return (
                <div className="nu-item" key={`${it.pk}-${it.si}-${it.ci}`} onClick={() => jumpTo(it.pk, it.si)}>
                  <div className="nu-rank">{i + 1}</div>
                  <div>
                    <div className="nu-name">{it.name}</div>
                    <div className="nu-why">{paperNm} · {it.reasons.join(' · ')}</div>
                  </div>
                  <div className="nu-badges">
                    <span className={`nu-tag ${it.tier}`}>{it.tier === 'hi' ? 'High wt' : it.tier === 'med' ? 'Med wt' : 'Low wt'}</span>
                    {it.conf === 1 && <span className="nu-tag red">Shaky</span>}
                    {it.rev && <span className="nu-tag revise">Revise</span>}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="pace">
            <div className="pace-txt">To finish all {stats.total} chapters by <b>Nov 2</b>, cover <b>{pace.perWeek.toFixed(1)}/week</b> (~<b>{pace.perDay.toFixed(1)}/day</b>). {pace.remaining} left · {pace.d} days.</div>
            <div className={`pace-state ${pace.cls}`}>{pace.label}</div>
          </div>
        </div>

        {/* OVERALL */}
        <div className="overall">
          <h3>Overall Group 1 Progress</h3>
          <div className="pbar"><div style={{ width: (stats.total ? (stats.done / stats.total) * 100 : 0) + '%' }} /></div>
          <div className="pbar-l">
            <span><b>{stats.done}</b> of {stats.total} chapters</span>
            <span>{stats.total ? Math.round((stats.done / stats.total) * 100) : 0}%</span>
          </div>
          <div className="paper-bars">
            {['fr', 'afm', 'aud'].map((pk) => {
              const p = stats.per[pk]; const pct = p.pt ? Math.round((p.pd / p.pt) * 100) : 0
              const nm = pk === 'fr' ? 'FR' : pk === 'afm' ? 'AFM' : 'Audit'
              return (
                <div className="pb-row" key={pk}>
                  <span className="pb-name">{nm}</span>
                  <div className="pb-track"><div className="pb-fill" data-p={pk} style={{ width: pct + '%' }} /></div>
                  <span className="pb-val"><b>{pct}%</b> · {p.pd}/{p.pt}</span>
                </div>
              )
            })}
          </div>
          <div className="mini-stats">
            <div className="ms"><div className="n">{Math.round(stats.hrs * 10) / 10}</div><div className="l">Hours logged</div></div>
            <div className="ms"><div className="n">{stats.shaky}</div><div className="l">Shaky (red)</div></div>
            <div className="ms"><div className="n">{stats.solid}</div><div className="l">Solid (green)</div></div>
            <div className="ms"><div className="n">{stats.hiLeft}</div><div className="l">High-wt left</div></div>
            <div className="ms"><div className="n">{stats.revDue}</div><div className="l">Due to revise</div></div>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          {['fr', 'afm', 'aud'].map((pk) => (
            <div key={pk} className={`tab${tab === pk ? ' active' : ''}`} data-p={pk} onClick={() => setTab(pk)}>
              <div className="code">Paper {pk === 'fr' ? 1 : pk === 'afm' ? 2 : 3}</div>
              <div className="nm">{pk === 'fr' ? 'Financial Reporting' : pk === 'afm' ? 'Adv. Fin. Mgmt' : 'Adv. Auditing'}</div>
              <div className="pc">{stats.per[pk].pt ? Math.round((stats.per[pk].pd / stats.per[pk].pt) * 100) : 0}%</div>
            </div>
          ))}
          {!isLight && (
            <>
              <div className={`tab${tab === 'mock' ? ' active' : ''}`} data-p="mock" onClick={() => setTab('mock')}>
                <div className="code">Track</div><div className="nm">Mock Scores</div><div className="pc">📊</div>
              </div>
              <div className={`tab${tab === 'plan' ? ' active' : ''}`} data-p="plan" onClick={() => setTab('plan')}>
                <div className="code">Strategy</div><div className="nm">Revision Plan</div><div className="pc">↗</div>
              </div>
              <div className={`tab${tab === 'how' ? ' active' : ''}`} data-p="how" onClick={() => setTab('how')}>
                <div className="code">Mindset</div><div className="nm">How to Pass</div><div className="pc">★</div>
              </div>
              <div className={`tab${tab === 'res' ? ' active' : ''}`} data-p="res" onClick={() => setTab('res')}>
                <div className="code">Learn</div><div className="nm">Resources</div><div className="pc">▶</div>
              </div>
            </>
          )}
        </div>

        {/* PAPER VIEWS */}
        {['fr', 'afm', 'aud'].map((pk) => (
          <div key={pk} className={`view${tab === pk ? ' active' : ''}`}>
            {tab === pk && (
              <PaperView pk={pk} g={g} isLight={isLight}
                openSet={openSecs[pk] || new Set()} onToggleSec={(si) => toggleSec(pk, si)}
                onDone={toggleDone} onHours={setHours} onConf={setConf}
                secNotes={store.secNotes || {}} onChNote={setChNote} onSecNote={setSecNote} />
            )}
          </div>
        ))}

        {/* MOCK */}
        <div className={`view${tab === 'mock' ? ' active' : ''}`}>
          {tab === 'mock' && <MockView mocks={mocks} setStore={setStore} />}
        </div>

        {/* PLAN */}
        <div className={`view${tab === 'plan' ? ' active' : ''}`}>
          {tab === 'plan' && <PlanView />}
        </div>

        {/* HOW */}
        <div className={`view${tab === 'how' ? ' active' : ''}`}>
          {tab === 'how' && <HowView />}
        </div>

        {/* RESOURCES */}
        <div className={`view${tab === 'res' ? ' active' : ''}`}>
          {tab === 'res' && <ResourcesView />}
        </div>

        {/* TOOLBAR */}
        <div className="toolbar">
          <button onClick={exportJSON}>Export progress</button>
          <button onClick={importJSON}>Import backup</button>
          <button onClick={reset}>Reset tracker</button>
        </div>
        <DeviceLink code={code} onSwitch={switchCode} />
        <div className="savenote">Progress saves automatically & syncs across your devices · Export regularly as backup</div>
        <div className="foot">Built for Swathi · Weightages are official ICAI BoS section-wise data (issued 26 Oct 2023, valid May 2024 to Nov 2026). ICAI does not publish chapter-level weightage; sub-splits are study guidance, not official.</div>
      </div>
    </div>
  )
}

/* ============================================================
   HOMEPAGE + CODE-ENTRY LOGIN  (share-code, no auth)
   ============================================================ */
const HOME_LINES = [
  'Every chapter you tick is a mark closer to those two letters after your name.',
  'You don’t have to do all of it today. You just have to do the next right thing.',
  'Consistency beats intensity. Show up, tick one more, repeat.',
  'The version of you on result day is built by the hours you put in now.',
  'Hard is not the same as impossible. This is just hard — and you do hard things.',
  '“Ready” is the goal, not “perfect”. Get ready, one chapter at a time.',
  'Small progress today. Steady progress tomorrow. Unstoppable by November.',
]

function Gate({ onChoose }) {
  const [val, setVal] = useState('')
  const submit = () => { const c = val.trim(); if (c) onChoose(c) }
  const d = daysLeft()
  const line = HOME_LINES[d % HOME_LINES.length]
  return (
    <div className="home">
      <div className="home-card">
        <div className="home-hero">
          <div className="home-kicker">CA Final · Group 1 · New Scheme · Nov 2026</div>
          <div className="home-banner">Swathi,<span className="we">We GOT THIS.</span></div>
          <div className="home-count"><b>{d}</b> days to FR · Group 1 begins Nov 2</div>
          <p className="home-line">{'“' + line + '”'}</p>
          <div className="home-feats">
            <span>✓ 166 chapters · 3 papers</span>
            <span>🎯 Study-now engine</span>
            <span>🔄 Syncs across your devices</span>
          </div>
        </div>
        <div className="home-login">
          <h3>Enter your code to begin</h3>
          <input
            className="gate-input"
            value={val}
            onChange={(e) => setVal(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="e.g. SWA-4X9K"
            spellCheck={false}
            autoFocus
          />
          <div className="gate-actions">
            <button className="gate-go" onClick={submit} disabled={!val.trim()}>Continue →</button>
            <button className="gate-gen" onClick={() => setVal(genCode())}>Generate a new code</button>
          </div>
          <p className="gate-tiny">
            Your code is your login — it keeps progress synced across every device. First time?
            Generate one and save it. Anyone with the code can view and edit, so keep it to yourself.
          </p>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   DEVICE LINK  (copy a ?code= link to open on another device)
   ============================================================ */
function DeviceLink({ code, onSwitch }) {
  const [copied, setCopied] = useState(false)
  const link = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code)}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (e) {
      window.prompt('Copy your device link:', link)
    }
  }
  return (
    <div className="devicelink">
      <span className="dl-code">Sync code: <b>{code}</b></span>
      <button className="dl-copy" onClick={copy}>{copied ? 'Copied ✓' : 'Copy device link'}</button>
      <button className="dl-switch" onClick={onSwitch}>Switch / log out</button>
    </div>
  )
}

/* ============================================================
   WHY ANCHOR
   ============================================================ */
function WhyAnchor({ why, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(why || '')
  const ref = useRef(null)
  useEffect(() => { if (editing && ref.current) ref.current.focus() }, [editing])
  useEffect(() => { setDraft(why || '') }, [why])

  if (editing) {
    return (
      <div className="why">
        <h3>Why this November</h3>
        <textarea ref={ref} className="why-edit" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="In your own words, why clearing this November matters to you. You'll see this on the hard days." />
        <div className="why-actions">
          <button className="save" onClick={() => { onSave(draft.trim()); setEditing(false) }}>Save</button>
          <button onClick={() => { setDraft(why || ''); setEditing(false) }}>Cancel</button>
        </div>
      </div>
    )
  }
  return (
    <div className="why">
      <h3>Why this November</h3>
      {why ? (
        <>
          <div className="why-text">{'\u201C' + why + '\u201D'}</div>
          <div className="why-tiny"><a onClick={() => setEditing(true)}>edit</a></div>
        </>
      ) : (
        <div className="why-text empty" onClick={() => setEditing(true)}>
          Tap to write your reason for clearing this November. One line, your words; it'll be here when you need it most.
        </div>
      )}
    </div>
  )
}

/* ============================================================
   PAPER VIEW (heatmap + sections + chapters + tips)
   ============================================================ */
function PaperView({ pk, g, isLight, openSet, onToggleSec, onDone, onHours, onConf, secNotes, onChNote, onSecNote }) {
  const P = PAPERS[pk]
  const totalCh = P.sections.reduce((a, s) => a + s.ch.length, 0)
  const [openNotes, setOpenNotes] = useState(() => new Set())
  const toggleNote = (k) => setOpenNotes((o) => {
    const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n
  })
  return (
    <>
      <div className="paper-head"><span className="paper-dot" style={{ background: P.dot }} /><h2>{P.name}</h2></div>
      <div className="paper-meta">{P.dur}</div>

      {!isLight && (
        <div className="heat">
          <h4>Confidence heatmap, {totalCh} chapters</h4>
          <div className="heat-grid">
            {P.sections.map((s, si) => s.ch.map((name, ci) => {
              const st = g(ck(pk, si, ci))
              let cls = 'heat-cell'
              if (st.conf === 1) cls += ' c1'; else if (st.conf === 2) cls += ' c2'; else if (st.conf === 3) cls += ' c3'
              if (!st.done) cls += ' done0'
              return <div key={`${si}-${ci}`} className={cls} title={`${name}${st.done ? ' · done' : ''}${st.conf ? ' · conf ' + st.conf : ''}`} />
            }))}
          </div>
          <div className="heat-legend">
            <span><i style={{ background: 'var(--shaky)' }} />Shaky</span>
            <span><i style={{ background: 'var(--mid)' }} />Medium</span>
            <span><i style={{ background: 'var(--go)' }} />Solid</span>
            <span><i style={{ background: 'var(--panel-2)', border: '1px solid var(--line)' }} />Not rated</span>
          </div>
        </div>
      )}

      {P.sections.map((s, si) => {
        const total = s.ch.length
        const done = s.ch.filter((_, ci) => g(ck(pk, si, ci)).done).length
        const isOpen = openSet.has(si)
        return (
          <div className={`sec${isOpen ? ' open' : ''}`} id={`sec-${pk}-${si}`} key={si}>
            <div className="sec-head" onClick={() => onToggleSec(si)}>
              <span className={`wt ${s.p}`}>{s.wt}</span>
              <span className="sec-title">{s.t}</span>
              <span className="sec-prog">{done}/{total}</span>
              <span className="sec-caret">▶</span>
            </div>
            <div className="sec-body">
              {!isLight && <div className="prio-note">{s.note}</div>}
              <div className="sec-note">
                <label>Section notes</label>
                <textarea
                  value={secNotes[`${pk}-${si}`] || ''}
                  placeholder="Strategy, formulae, examiner focus, weak spots for this section…"
                  onChange={(e) => onSecNote(pk, si, e.target.value)} />
              </div>
              {s.ch.map((name, ci) => {
                const k = ck(pk, si, ci); const st = g(k); const rev = reviseDue(st)
                let revChip = null
                if (rev === 'due') revChip = <span className="rev-chip due">↻ revise now</span>
                else if (rev === 'overdue') revChip = <span className="rev-chip due">↻ revise (overdue)</span>
                else if (st.done && st.conf === 3) revChip = <span className="rev-chip">✓ solid</span>
                return (
                  <React.Fragment key={ci}>
                  <div className={`ch${st.done ? ' done' : ''}${rev ? ' reviseflag' : ''}`}>
                    <div className={`cbx${st.done ? ' on' : ''}`} onClick={() => onDone(k)}>{st.done ? '✓' : ''}</div>
                    <div>
                      <div className="ch-name">{name}</div>
                      <div className="ch-meta">
                        <span>{st.hrs > 0 ? st.hrs + ' h' : '·'}{st.conf ? ' · conf ' + st.conf + '/3' : ''}</span>
                        {revChip}
                        {st.note ? <span className="note-flag">📝 note</span> : null}
                      </div>
                    </div>
                    <div className="ch-ctrl">
                      {!isLight && (
                        <div className="hbox">⏱
                          <input type="number" min="0" step="0.5" value={st.hrs || ''} placeholder="0"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onHours(k, e.target.value)} />
                        </div>
                      )}
                      <div className="conf">
                        {[1, 2, 3].map((v) => (
                          <b key={v} data-v={v} className={st.conf === v ? 's' : ''} onClick={() => onConf(k, v)}>{v}</b>
                        ))}
                      </div>
                      <button className={`note-btn${st.note ? ' has' : ''}${openNotes.has(k) ? ' open' : ''}`}
                        title="Add a note" onClick={() => toggleNote(k)}>📝</button>
                    </div>
                  </div>
                  {openNotes.has(k) && (
                    <div className="ch-note">
                      <textarea value={st.note || ''} autoFocus
                        placeholder="Your note for this chapter — doubts, formulae, page refs, where you stopped…"
                        onChange={(e) => onChNote(k, e.target.value)} />
                    </div>
                  )}
                  </React.Fragment>
                )
              })}
            </div>
          </div>
        )
      })}

      {!isLight && (
        <div className="tips">
          <h4>How to score {P.name.split(',')[0]}</h4>
          <ul>{P.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <div className="resources">
            {P.res.map((r, i) => <a key={i} href={r[1]} target="_blank" rel="noopener noreferrer">{r[0]} ↗</a>)}
          </div>
        </div>
      )}
    </>
  )
}

/* ============================================================
   MOCK SCORE VIEW
   ============================================================ */
function MockView({ mocks, setStore }) {
  const [paper, setPaper] = useState('fr')
  const [score, setScore] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')

  const add = () => {
    const sc = parseInt(score)
    if (isNaN(sc) || sc < 0 || sc > 100) { alert('Enter a score between 0 and 100'); return }
    setStore((s) => ({ ...s, mocks: [...(s.mocks || []), { id: Date.now(), paper, score: sc, date: date || new Date().toISOString().slice(0, 10), note: note.trim() }] }))
    setScore(''); setNote('')
  }
  const del = (id) => setStore((s) => ({ ...s, mocks: (s.mocks || []).filter((m) => m.id !== id) }))

  const sorted = [...mocks].sort((a, b) => b.date.localeCompare(a.date))
  return (
    <>
      <div className="paper-head"><h2>Mock Score Tracker</h2></div>
      <div className="mock-intro">Log every past paper, MTP and full mock. The trend toward <b>40 per paper</b> is the truest signal of readiness, more than chapters ticked.</div>
      <div className="mock-add">
        <div><label>Paper</label>
          <select value={paper} onChange={(e) => setPaper(e.target.value)}>
            <option value="fr">Financial Reporting</option>
            <option value="afm">Adv. Fin. Mgmt</option>
            <option value="aud">Adv. Auditing</option>
          </select>
        </div>
        <div><label>Score /100</label><input type="number" min="0" max="100" placeholder="0" value={score} onChange={(e) => setScore(e.target.value)} /></div>
        <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label>Note (e.g. MTP-1)</label><input type="text" placeholder="optional" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div><button onClick={add}>Log</button></div>
      </div>

      <div className="trend">
        <h4>Best & latest per paper (pass line = 40)</h4>
        {['fr', 'afm', 'aud'].map((pk) => {
          const rows = mocks.filter((m) => m.paper === pk).sort((a, b) => a.date.localeCompare(b.date))
          const nm = PAPERS[pk].name.split(',')[0]
          if (!rows.length) return <div className="mock-meta" key={pk} style={{ margin: '6px 0' }}>{nm}: no mocks yet</div>
          const best = Math.max(...rows.map((r) => r.score))
          const latest = rows[rows.length - 1].score
          const spark = rows.map((r) => r.score).join(' → ')
          return <div key={pk} style={{ margin: '8px 0', fontSize: 13 }}><b style={{ color: PAPERS[pk].dot }}>{nm}</b> — best {best}, latest {latest} <span className="mock-meta">· {spark}</span></div>
        })}
      </div>

      {sorted.length === 0 ? (
        <div className="empty-mock">No scores logged yet. Add your first past-paper attempt above, even a rough self-marked score counts.</div>
      ) : sorted.map((m) => {
        const pass = m.score >= 40
        return (
          <div className="mock-row" key={m.id}>
            <span className="mock-dot" style={{ background: PAPERS[m.paper].dot }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{PAPERS[m.paper].name.split(',')[0]}</div>
              <div className="mock-meta">{m.date}{m.note ? ' · ' + m.note : ''}</div>
            </div>
            <span className={`mock-score ${pass ? 'pass' : 'fail'}`}>{m.score}</span>
            <span className="mock-meta">{pass ? 'PASS' : 'below 40'}</span>
            <button className="mock-del" onClick={() => del(m.id)}>✕</button>
          </div>
        )
      })}
    </>
  )
}

/* ============================================================
   PLAN + HOW
   ============================================================ */
function PlanView() {
  return (
    <>
      <div className="callout"><b>Swathi, this is a ~13-week runway to Nov 2026.</b><br />Three passes: learn it, apply it, recall it. Then simulate the real thing. Adjust week counts to your actual start date.</div>
      {PLAN.map((ph, i) => (
        <div className="phase" key={i}>
          <span className="phase-tag">{ph.tag}</span>
          <h3>{ph.h}</h3>
          <p>{ph.p}</p>
          <ul>{ph.li.map((l, j) => <li key={j}>{l}</li>)}</ul>
        </div>
      ))}
      <div className="callout">Exam order: <b>FR (Nov 2) → AFM (Nov 4) → Audit (Nov 6)</b>. In the final sprint, practise papers in this sequence so your brain is grooved to it.</div>
    </>
  )
}
function HowView() {
  return (
    <>
      <div className="callout"><b>Eight rules that decide the result.</b><br />Not motivation, mechanics. Follow the map, protect the floor, attempt everything.</div>
      {RULES.map((r, i) => (
        <div className="rulecard" key={i}>
          <div className="num">{r[0]}</div>
          <div><h4>{r[1]}</h4><p>{r[2]}</p></div>
        </div>
      ))}
      <div className="callout" style={{ marginTop: 20, fontSize: 16 }}><b>Swathi, We GOT THIS.</b> 🎯<br /><span style={{ color: 'var(--dim)', fontSize: 13 }}>One chapter at a time. Tick it, log it, rate it. Watch the bar fill.</span></div>
    </>
  )
}

/* ============================================================
   RESOURCES VIEW — curated best lectures + official ICAI links
   Video links use YouTube search so they always surface the
   current top-rated results (no dead/expiring single-video URLs).
   ICAI links are official Board of Studies pages (verified).
   ============================================================ */
const yt = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`

const RES_OFFICIAL = [
  { t: 'ICAI Study Material — Knowledge Portal', u: 'https://www.icai.org/post/bos-knowledge-portal', d: 'Official modules for all three papers' },
  { t: 'Revision Test Papers (RTP)', u: 'https://boslive.icai.org/education_content_rtp.php', d: 'Latest RTPs — do these before the exam' },
  { t: 'Mock Test Papers (MTP)', u: 'https://boslive.icai.org/education_content_modelTestPapers.php', d: 'ICAI mock papers with solutions' },
  { t: 'Past Papers + Suggested Answers', u: 'https://boslive.icai.org/education_content.php?p=Question+Papers', d: 'Previous attempts & examiner answers' },
  { t: 'ICAI BoS — Live & Recorded Classes', u: 'https://boslive.icai.org/', d: 'Free official lectures & LVC schedule' },
  { t: 'ICAI BoS on YouTube', u: 'https://www.youtube.com/c/THEICAIBOS', d: 'Official BoS video channel' },
]

const RES_PAPERS = {
  fr: {
    name: 'Financial Reporting', tier: 'fr',
    items: [
      { t: 'CA Parveen Sharma — FR full lectures', d: 'Concept-first, Ind AS depth', u: yt('CA Final FR Financial Reporting Parveen Sharma new scheme') },
      { t: 'CA Aakash Kandoi — FR lectures & revision', d: 'Popular for problem practice', u: yt('CA Final FR Aakash Kandoi revision new scheme') },
      { t: 'FR fast-track revision (Nov 2026)', d: 'Rapid pre-exam pass', u: yt('CA Final FR fast track revision Nov 2026 new scheme') },
      { t: 'Ind AS conceptual playlists', d: 'Standard-by-standard', u: yt('CA Final FR Ind AS revision lectures new scheme') },
    ],
  },
  afm: {
    name: 'Advanced Financial Management', tier: 'afm',
    items: [
      { t: 'CA Aaditya Jain — AFM full lectures', d: 'Widely rated for AFM/SFM', u: yt('CA Final AFM Advanced Financial Management Aaditya Jain new scheme') },
      { t: 'CA Sanjay Saraf — AFM lectures', d: 'Strong on theory + derivatives', u: yt('CA Final AFM Sanjay Saraf') },
      { t: 'AFM fast-track revision (Nov 2026)', d: 'Formula + problem sprint', u: yt('CA Final AFM fast track revision Nov 2026') },
      { t: 'Derivatives & Portfolio problem drills', d: 'High-weight problem areas', u: yt('CA Final AFM derivatives portfolio management problems revision') },
    ],
  },
  aud: {
    name: 'Advanced Auditing', tier: 'aud',
    items: [
      { t: 'CA Sanidhya Saraf — Audit lectures', d: 'Popular Advanced Auditing faculty', u: yt('CA Final Advanced Auditing Sanidhya Saraf new scheme') },
      { t: 'CA Surbhi Bansal — Audit lectures', d: 'Trusted audit notes & classes', u: yt('CA Final Advanced Auditing Surbhi Bansal') },
      { t: 'Audit fast-track revision (Nov 2026)', d: 'Presentation-focused pass', u: yt('CA Final Advanced Auditing fast track revision Nov 2026') },
      { t: 'Standards on Auditing (SA) quick revision', d: 'SA-wise rapid recall', u: yt('CA Final Advanced Auditing Standards on Auditing SA revision') },
    ],
  },
}

function ResourcesView() {
  return (
    <>
      <div className="paper-head"><h2>Resources</h2></div>
      <div className="mock-intro">
        Curated best-rated lectures and the official ICAI material, per paper. Video links open a
        live YouTube search, so you always land on the current top-rated results — pick the newest
        <b> New Scheme / Nov 2026</b> uploads.
      </div>

      <div className="res-official">
        <h4>Official ICAI — do not skip</h4>
        <div className="res-grid">
          {RES_OFFICIAL.map((r, i) => (
            <a className="res-card official" key={i} href={r.u} target="_blank" rel="noopener noreferrer">
              <div className="res-t">{r.t}</div>
              <div className="res-d">{r.d}</div>
              <span className="res-go">Open ↗</span>
            </a>
          ))}
        </div>
      </div>

      {['fr', 'afm', 'aud'].map((pk) => {
        const P = RES_PAPERS[pk]
        return (
          <div className="res-paper" key={pk}>
            <div className="res-paper-head"><span className={`wt ${P.tier}`}>{pk.toUpperCase()}</span><h4>{P.name}</h4></div>
            <div className="res-grid">
              {P.items.map((r, i) => (
                <a className="res-card" key={i} href={r.u} target="_blank" rel="noopener noreferrer">
                  <div className="res-t">▶ {r.t}</div>
                  <div className="res-d">{r.d}</div>
                  <span className="res-go">Watch ↗</span>
                </a>
              ))}
            </div>
          </div>
        )
      })}

      <div className="savenote">Links open in a new tab. Faculty picks are popular community-rated names — try a lecture before committing a full course.</div>
    </>
  )
}
