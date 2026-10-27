// Google Sheet access (sheet shared as "Anyone with the link can view"). Read-only.

/** Sheet ID and tab gid from a Google Sheets URL (or a bare ID). */
export function parseSheetUrl(url) {
  const s = String(url || '').trim();
  const id = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] || (/^[a-zA-Z0-9_-]{30,}$/.test(s) ? s : null);
  if (!id) throw new Error('That is not a Google Sheets link. It should look like https://docs.google.com/spreadsheets/d/…/edit');
  return { sheetId: id, gid: s.match(/[#&?]gid=(\d+)/)?.[1] || null };
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Sheet title and tabs: { title, tabs: [{ gid, name }] } */
export async function connectSheet(sheetId) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
  const html = await r.text();
  const tabs = [...html.matchAll(/\{name: "([^"]+)", pageUrl: "[^"]*gid=(\d+)/g)].map((m) => ({ name: m[1], gid: m[2] }));
  if (!r.ok || !tabs.length) throw new Error('Could not open this sheet. In Google Sheets click Share → General access → "Anyone with the link" (Viewer), then try again.');
  const title = (html.match(/<title>([^<]*)<\/title>/)?.[1] || '').replace(/ - Google (Sheets|Drive)$/, '').trim();
  return { sheetId, title, tabs };
}

// Column headers differ per tab, so find columns by name.
const COLS = {
  title: /^(title|news title|topic|blog title)$/i,
  taskId: /^task\s*id$/i,
  writer: /^writer$/i,
  docUrl: /^doc\s*url$/i,
  category: /^(category|content\s*type)$/i,
  liveUrl: /^(live\s*url|url|page\s*url|silo\s*url)$/i, // which silo of a college/exam/course task the doc is for
};

/** Rows from start (to end, or the last row with a Task ID; max 50): [{ row, title, taskId, writer, docUrl, category }] */
export async function readRows(sheetId, gid, start, end = null) {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`);
  if (!r.ok) throw new Error(`Could not read the sheet (HTTP ${r.status}). Is it shared as "Anyone with the link"?`);
  const rows = parseCsv(await r.text());
  const header = rows[0].map((h) => h.replace(/\s+/g, ' ').trim());
  const col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, header.findIndex((h) => re.test(h))]));
  const missing = ['taskId', 'docUrl'].filter((k) => col[k] < 0);
  if (missing.length) throw new Error(`This tab has no ${missing.map((k) => (k === 'taskId' ? '"Task ID"' : '"Doc URL"')).join(' / ')} column. Headers: ${header.filter(Boolean).join(', ')}`);
  const cell = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
  let lastRow = rows.length;
  while (lastRow > 1 && !cell(rows[lastRow - 1], 'taskId') && !cell(rows[lastRow - 1], 'docUrl')) lastRow--;

  start = Number(start);
  if (!(start >= 2)) throw new Error('Start row must be 2 or more (row 1 is the header)');
  if (start > lastRow) throw new Error(`Start row ${start} is after the last filled row (${lastRow})`);
  const stop = Math.min(end ? Number(end) : lastRow, lastRow, start + 49);
  const list = [];
  for (let n = start; n <= stop; n++) {
    const row = rows[n - 1] || [];
    if (!cell(row, 'taskId') && !cell(row, 'docUrl')) continue;
    list.push({ row: n, title: cell(row, 'title'), taskId: cell(row, 'taskId'), writer: cell(row, 'writer'), docUrl: cell(row, 'docUrl'), category: cell(row, 'category'), liveUrl: cell(row, 'liveUrl') });
  }
  return list;
}
