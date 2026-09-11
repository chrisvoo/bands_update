# bands_update — Agent Instructions

## Project overview

A Node.js (ESM) script that polls the MusicBrainz API to detect new studio album
releases for a tracked list of bands (`checks.json`). Run with `node index.mjs`
or `node index.mjs --force`.

## Module layout

| File | Purpose |
|------|---------|
| `index.mjs` | Entry point: CLI flags, progress bar, summary table, JSON I/O |
| `musicbrainz.mjs` | MusicBrainz API: `getReleaseGroups()`, rate-limited fetch, retry/backoff |
| `utils.mjs` | Pure functions: state machine, filtering, duplicate check, schema migration |
| `utils.test.mjs` | Unit tests for everything in `utils.mjs` |
| `musicbrainz.test.mjs` | Tests for `getReleaseGroups` with mocked fetch |
| `checks.json` | Persistent state: 238 bands, ~70 KB, plain JSON (no DB) |

## Running

```bash
node index.mjs            # normal run — skips bands checked today
node index.mjs --force    # re-check every band regardless of last_check
npm test                  # run the test suite (node --test, Node 22+)
```

## Key design decisions

### State machine

`computeBandUpdate(band, latestAlbum, today, force)` in `utils.mjs` is the
central logic unit. It returns `{ action, set, unset }` — never mutates the
band directly. `index.mjs` applies the result with `applyDecision()`.

Pre-fetch actions (when `latestAlbum === null`):
- `skip` — nothing to do (future upcoming date, or checked today and no --force)
- `report_missing` — `band.missing` is set; report it without calling MB
- `fetch` — proceed with the API call

Post-fetch actions:
- `set_upcoming` — MB album has a future release date
- `update_check` — album matches `last_album`; just refresh `last_check`
- `set_missing` — new album detected; set `band.missing`

### Rate limiting

`musicbrainz.mjs` tracks `lastCallTime` at module level. Each fetch waits only
the *remaining* time to reach 1000 ms since the previous call started (not a
fixed 1000 ms sleep after the fetch completes). This saves ~300 ms per band vs.
the naive approach.

`getReleaseGroups` accepts `{ fetchFn, rateLimitMs, retryDelays }` for testing —
pass `{ rateLimitMs: 0, retryDelays: [0, 0, 0] }` to skip all sleeping in tests.
Call `_resetRateLimit()` between tests to clear module-level state.

### upcoming field schema

Old format: `upcoming: true` → the script will do a MB call and migrate it.
New format: `upcoming: { album_name: "...", release_date: "YYYY-MM-DD" }`.

If `release_date > today` and no `--force`: the band is silently skipped (no
MB call, no report). When the date passes, the next run treats the band normally.

### Pagination

`getReleaseGroups` uses a `for (let page = 0; page < totalPages; page++)` loop.
`totalPages` is set from `release-group-count` after the first response. Do not
use a do/while with a decrementing counter — that pattern had an inverted exit
condition bug that skipped all pages after the first for prolific artists.

### Retry/backoff

`fetchPageWithRetry` retries up to `retryDelays.length` times (default: 3),
covering both network failures (fetch throws) and API-level errors (`data.error`).
After all retries fail for a band, `index.mjs` breaks the loop, writes JSON, and
exits with code 1. Progress up to that point is persisted.

### JSON persistence

`writeBands` is called in a `finally` block so it always runs — even when a
fatal error occurs mid-loop. `process.exit(1)` is called only *after* `finally`
completes (using a `fatalError` flag, not a throw inside finally).

## checks.json schema

```jsonc
{
  "Band Name": {
    "last_album": "Album Title",           // last known studio album
    "last_album_release_date": "YYYY-MM-DD",
    "last_check": "YYYY-MM-DD",            // date of last MB check
    "musicbrainz_id": "<MBID>",
    "discography_url": "<URL>",            // informational only
    "exclude": ["Title to ignore"],        // optional: titles MB returns that we skip
    "missing": "New Album Title",          // set when MB has a newer album than last_album
    "upcoming": {                          // set when MB album has a future release date
      "album_name": "Title",
      "release_date": "YYYY-MM-DD"
    }
  }
}
```

`musicbrainz_id` and `discography_url` must be unique across all entries. The
startup duplicate check will print offenders and exit before any API calls.

## Known data issues (fix before first run)

Two `discography_url` collisions exist in the current `checks.json`:
- `Megadeth` and `Max Gazzè` share a Wikipedia URL (Megadeth's URL is wrong)
- `Sepultura` and `Seven Spires` share a Wikipedia URL (Seven Spires needs its own)

The Paramore entry had a `last_abum` typo — `migrateBandSchema()` fixes it
automatically on the first run.

## Adding a new band

Add an entry to `checks.json` with at minimum:
```json
"Band Name": {
  "last_album": "Most Recent Studio Album",
  "last_album_release_date": "YYYY-MM-DD",
  "last_check": "1970-01-01",
  "musicbrainz_id": "<find at musicbrainz.org>",
  "discography_url": "<wikipedia discography URL>"
}
```

Set `last_check` to `1970-01-01` so the script checks it on the next run.

## Testing conventions

- Tests use `node:test` + `node:assert/strict` — no Jest, no Vitest.
- Test files are `*.test.mjs` in the project root; `npm test` discovers them automatically.
- **Every new feature or behaviour change must include a test.** Write code in a
  modular and testable way: pure functions in `utils.mjs`, I/O isolated in its
  own module, dependencies injected so they can be replaced in tests.
- **After any change, run `npm test` and fix all failures before considering the
  work done.** Do not skip this step even for changes that look trivial.
- `computeBandUpdate` is the most critical function to keep tested — it encodes
  all the skip/missing/upcoming logic. Any new condition must get a test case.
- For `musicbrainz.test.mjs`, always pass `{ rateLimitMs: 0, retryDelays: [0,0,0] }`
  to keep tests fast, and call `_resetRateLimit()` in `beforeEach`.
