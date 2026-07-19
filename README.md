# Swathi — CA Final Group 1 Tracker (React)

Vite + React single-page app. CA Final Group 1 (FR, AFM, Advanced Auditing) revision tracker for Nov 2026.

## Run locally
```bash
npm install
npm run dev      # dev server
npm run build    # production build → dist/
npm run preview  # preview the build
```

## Structure
- `src/App.jsx` — the entire app, one big component (plus small child components for WhyAnchor, PaperView, MockView, PlanView, HowView). Intentionally kept in one file for simplicity.
- `src/data.js` — verified ICAI syllabus data: `PAPERS` (166 chapters across 3 papers, official section weightages), `PLAN` (revision phases), `RULES` (how-to-pass).
- `src/styles.css` — all styling. Light/Full theme via a `.light` class on the root div.

## Features
- 166 chapters, each with tick + hours + confidence (1–3)
- Study-now engine (ranks by weightage × weakness × time-left)
- Spaced revision (chapters resurface 7/14 days after completion)
- Daily pace vs. Nov 2 countdown
- Confidence heatmap per paper
- Mock score log with per-paper trend
- WhatsApp one-tap daily update (to +91 98850 34568)
- Personal "why" anchor + warm encouragement / gentle stall nudges
- Full / Light view toggle
- Export / Import JSON backup

## Persistence — Supabase share-code sync
All app state is a single blob:
```js
{ ch: {chapterKey: {done, hrs, conf, doneAt, hrsAt}}, mocks: [], why: "", mode: "full" }
```

Sync is **share-code based, no login**:
- A **share code** (e.g. `SWA-4X9K`) identifies one saved blob. It's read from the
  `?code=` URL param (for opening on another device), else from localStorage, else
  generated on the entry screen.
- The blob is stored in Supabase table `progress` and cached in localStorage as an
  offline fallback. Writes are debounced ~800ms; last-write-wins.
- A small badge shows `synced ✓` / `saving…` / `offline`.
- If the Supabase env vars are absent, the app runs localStorage-only (offline).

The persistence layer lives at the top of `src/App.jsx` (helpers + the two boot/save
`useEffect`s) plus `src/supabaseClient.js`. The rest of the component is unchanged and
`App.jsx` remains one main component.

### Environment variables
Set these (locally in `.env`, and in Vercel Project Settings → Environment Variables):
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```
The anon key in the frontend is expected and safe — RLS scopes anon read/write to the
matching `share_code`.

### Supabase setup (one-time)
Create a project, then run this in the SQL Editor:
```sql
create table if not exists public.progress (
  share_code text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.progress enable row level security;

create policy "anon read by share_code"  on public.progress for select to anon using (true);
create policy "anon insert by share_code" on public.progress for insert to anon with check (true);
create policy "anon update by share_code" on public.progress for update to anon using (true) with check (true);
```

## Data note
Weightages are official ICAI BoS section-wise data (issued 26 Oct 2023, valid May 2024 → Nov 2026). ICAI does not publish chapter-level weightage; the chapter sub-splits within each section are study guidance, not official ICAI figures.
