import { readFile, mkdir, writeFile } from 'fs/promises';

const data = JSON.parse(await readFile('results.json', 'utf8'));
const findings = data.findings ?? [];
const newCount = findings.filter(f => f.action === 'set_missing').length;
const missingCount = findings.filter(f => f.action === 'report_missing').length;

const esc = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = findings.map(f => {
    const isNew = f.action === 'set_missing';
    const badge = isNew
        ? '<span class="badge badge-new">NEW</span>'
        : '<span class="badge badge-missing">STILL MISSING</span>';
    return `<tr><td>${esc(f.bandName)}</td><td>${badge}</td><td>${esc(f.album)}</td><td class="date">${esc(f.releaseDate)}</td></tr>`;
}).join('\n');

const tableHTML = rows
    ? `<table><thead><tr><th>Band</th><th>Status</th><th>Album</th><th>Release Date</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
    : '<p class="empty">No new albums found this month.</p>';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Album Radar — ${esc(data.date)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --new: #3fb950;
      --missing: #d29922;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      padding: 2rem 1.5rem;
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.5;
    }
    header { margin-bottom: 2rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .meta { color: var(--muted); font-size: 0.875rem; }
    .stats {
      display: flex;
      gap: 1rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.5rem;
      min-width: 130px;
    }
    .stat-value { font-size: 2rem; font-weight: 700; line-height: 1.1; }
    .stat-value.green { color: var(--new); }
    .stat-value.yellow { color: var(--missing); }
    .stat-label { color: var(--muted); font-size: 0.8rem; margin-top: 0.25rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      font-size: 0.9rem;
    }
    th {
      background: #1c2128;
      text-align: left;
      padding: 0.65rem 1rem;
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
    }
    td { padding: 0.7rem 1rem; border-top: 1px solid var(--border); }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .badge {
      display: inline-block;
      padding: 0.2em 0.55em;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-new { background: rgba(63, 185, 80, 0.15); color: var(--new); }
    .badge-missing { background: rgba(210, 153, 34, 0.15); color: var(--missing); }
    .date { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
    .empty { color: var(--muted); font-style: italic; padding: 1rem 0; }
    footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
    @media (max-width: 600px) {
      .stat-value { font-size: 1.5rem; }
      td, th { padding: 0.6rem 0.6rem; }
    }
  </style>
</head>
<body>
  <header>
    <h1>&#127928; New Album Radar</h1>
    <p class="meta">Last checked: ${esc(data.date)} &bull; completed in ${data.elapsed_seconds.toFixed(1)}s</p>
  </header>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${data.bands_total}</div>
      <div class="stat-label">Bands tracked</div>
    </div>
    <div class="stat">
      <div class="stat-value green">${newCount}</div>
      <div class="stat-label">New albums</div>
    </div>
    <div class="stat">
      <div class="stat-value yellow">${missingCount}</div>
      <div class="stat-label">Still missing</div>
    </div>
  </div>

  ${tableHTML}

  <footer>Updated monthly via MusicBrainz.</footer>
</body>
</html>`;

await mkdir('site', { recursive: true });
await writeFile('site/index.html', html, 'utf8');
console.log('Generated site/index.html');
