import 'dotenv/config';

// Payload CMS client, logged in as the writer account from .env (content is saved as that writer).
const BASE = process.env.CMS_URL;
let token = null;
let tokenAt = 0;
let me = null;

async function login() {
  const r = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.CMS_EMAIL, password: process.env.CMS_PASSWORD }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('CMS login failed — check CMS_EMAIL / CMS_PASSWORD in .env');
  token = j.token;
  tokenAt = Date.now();
  me = j.user;
}

async function api(path, opts = {}, retried = false) {
  if (!token || Date.now() - tokenAt > 60 * 60 * 1000) await login();
  const r = await fetch(`${BASE}/api${path}`, { ...opts, headers: { Authorization: `JWT ${token}`, ...opts.headers } });
  if (r.status === 401 && !retried) { token = null; return api(path, opts, true); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    const fields = (j.errors || []).flatMap((e) => (e.data || []).map((d) => `${d.field}: ${d.message}`));
    throw new Error(`CMS ${opts.method || 'GET'} ${path.split('?')[0]}: ${fields.length ? fields.join('; ') : j.errors?.[0]?.message || j.message || r.status}`);
  }
  return j;
}

export const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
export const cmsGet = (path) => api(path);
export async function getMe() { if (!me) await login(); return me; }
export const cmsUrl = () => BASE;

/**
 * Save content the way the CMS writer screen does: PATCH the page with a form-data "_payload"
 * and the user action in "X-User-Action" ("saveContent" = draft, "submitContentForCW" = send for review).
 * The CMS stores it in the page's draft version, not on the live page.
 */
export function savePage(collection, id, data, action = 'saveContent') {
  const fd = new FormData();
  fd.append('_payload', JSON.stringify({ ...data, id, _status: 'draft' }));
  return api(`/${collection}/${id}?depth=0`, { method: 'PATCH', headers: { 'X-User-Action': action }, body: fd });
}

/** Upload an image the way the CMS hero-image picker does: media file first, then a mediaRef that pages point to. */
export async function uploadImage({ buffer, fileName, mimeType, caption, altText, tags, collectionName }) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mimeType }), fileName);
  fd.append('_payload', JSON.stringify({ caption }));
  const media = await api('/media', { method: 'POST', body: fd });
  const mediaId = media.doc?.id || media.id;
  const ref = await api('/mediaRef', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ caption, altText, tags, mediaId, collectionName, fileType: 'image' }),
  });
  return { mediaRefId: ref.doc?.id, mediaId, url: media.doc?.imagekit?.url || media.doc?.url || '' };
}
