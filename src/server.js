import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { parseSheetUrl, connectSheet, readRows } from './sheets.js';
import { prepare, upload, submitDraft } from './upload.js';
import { makeHero } from './hero.js';
import { getMe, cmsUrl, cmsGet } from './cms.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3002;

// Optional login (browser pop-up) — set DASHBOARD_PASSWORD when the app is online.
app.use((req, res, next) => {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass || req.path === '/health') return next();
  const b64 = (req.headers.authorization || '').split(' ')[1] || '';
  const pw = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
  if (pw === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="SYU Writer Agent"').status(401).send('Login required');
});

const route = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(400).json({ error: e.message }); } };
app.get('/health', (_, res) => res.send('ok'));
app.get('/api/account', route(async () => ({ email: (await getMe()).email, cmsUrl: cmsUrl() })));
app.post('/api/connect', route(async (req) => {
  const { sheetId, gid } = parseSheetUrl(req.body.url);
  return { ...(await connectSheet(sheetId)), gid };
}));
app.post('/api/preview', route(async (req) => {
  const rows = (await readRows(req.body.sheetId, req.body.gid, req.body.start, req.body.end || null)).map((r) => ({ ...r, tab: req.body.name }));
  // One row at a time (each reads a doc and the CMS) — the least memory, which matters on a busy PC.
  const out = [];
  for (const r of rows) out.push(await prepare(r, { allowOtherEntity: !!req.body.allowOtherEntity }));
  return out;
}));
app.post('/api/preview-manual', route((req) => prepare({ row: 1, manual: true, ...req.body }, { allowOtherEntity: !!req.body.allowOtherEntity })));
// Writers for the manual dropdown; the display name ("Puja Das") is used as the blog author name.
app.get('/api/writers', route(async () => {
  const users = (await cmsGet('/users?limit=500&depth=1')).docs.filter((u) => /writer/i.test(u.role?.name || ''));
  const nameOf = (u) => (u.name && !/^content writer$/i.test(u.name) ? u.name
    : u.email.split('@')[0].replace(/^update_/, '').split(/[._-]/).filter((w) => !/^(cw|ce)$/.test(w)).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
  return users.map((u) => ({ email: u.email, name: nameOf(u) })).sort((a, b) => a.name.localeCompare(b.name));
}));
app.get('/api/hero', async (req, res) => {
  try { res.type('image/webp').send(await makeHero(String(req.query.h1 || ''))); } catch (e) { res.status(400).send(e.message); }
});
app.post('/api/upload', route(async (req) => {
  const r = await upload(req.body.row, { submit: !!req.body.submit, allowOtherEntity: !!req.body.allowOtherEntity });
  console.log(`[upload] row ${r.row} → task ${r.taskId}: ${r.status}${r.submitted ? ' (submitted)' : ''}${req.body.allowOtherEntity ? ' [test mode]' : ''}`);
  return r;
}));
app.post('/api/submit', route(async (req) => {
  const r = await submitDraft(req.body.taskId, req.body.liveUrl);
  console.log(`[submit] task ${r.taskId}: ${r.status}`);
  return r;
}));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.listen(PORT, () => console.log(`SYU Writer Agent - SYUW1 (beta 0.0) on http://localhost:${PORT}`));
