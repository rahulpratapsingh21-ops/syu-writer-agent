import { cmsGet, qs } from './cms.js';

// Automatic internal links: SYU exams, colleges and courses named in the text → their SYU pages,
// plus related published blogs for the "Don't Miss" list.
const SITE = 'https://www.selectyouruniversity.com';
const MAX_LINKS = 8; // new inline links per page
const STOP = new Set(['The', 'This', 'These', 'That', 'There', 'Here', 'Candidates', 'Students', 'Round', 'Step', 'Category', 'Total', 'India', 'Indian',
  'Government', 'State', 'Central', 'Private', 'University', 'College', 'Universities', 'Colleges', 'Exam', 'Result', 'Results', 'Yes', 'No', 'Ans', 'Ques',
  'Check', 'Click', 'Visit', 'Download', 'Open', 'Go', 'Under', 'After', 'Before', 'Also', 'However', 'Meanwhile', 'Formerly', 'Seats', 'Seat', 'Merit', 'List']);

const norm = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- exam names (small list, cached for a day) -----------------------------------------------
let examCache = null, examAt = 0;
async function exams() {
  if (examCache && Date.now() - examAt < 864e5) return examCache;
  const list = [];
  for (let page = 1; ; page++) {
    const j = await cmsGet(`/exams?${qs({ limit: 500, page, depth: 0, 'where[status][equals]': 'approved' })}`);
    for (const e of j.docs) for (const n of new Set([e.name, ...(e.alsoKnownAs || [])])) if (n && n.trim().length >= 3) list.push({ name: n.trim(), number: e.number, pop: e.popularityScore || 0 });
    if (!j.hasNextPage) break;
  }
  examCache = list.sort((a, b) => b.name.length - a.name.length || b.pop - a.pop); examAt = Date.now();
  return examCache;
}

// ---- URL of an entity on the live site (exact address, checked) -----------------------------
const urlCache = new Map();
async function liveUrl(type, number, id) {
  const key = `${type}-${number}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const code = { exam: 'eid', course: 'mci', college: 'cid' }[type];
  let url = null;
  try {
    if (type === 'college') {
      // College pages answer to any address, so take the real one from the college's published overview page.
      const p = (await cmsGet(`/collegePages?${qs({ 'where[dataRef.value][equals]': id, 'where[page][equals]': 'overview', 'where[status][equals]': 'published', limit: 1, depth: 0 })}`)).docs[0];
      if (p?.pageUrl && (await fetch(`${SITE}/college/${p.pageUrl}`, { method: 'HEAD' })).ok) url = `${SITE}/college/${p.pageUrl}`;
    } else {
      const r = await fetch(`${SITE}/${type}/x-${code}-${number}`, { redirect: 'manual' }); // exams/courses redirect to their real address
      if (r.status >= 300 && r.status < 400) url = new URL(r.headers.get('location'), SITE).href;
    }
    if (url && !new RegExp(`/${type}/[^/]+-${code}-${number}$`).test(url)) url = null;
  } catch {}
  urlCache.set(key, url);
  return url;
}

// ---- find entity mentions ----------------------------------------------------------------------
/** Capitalised names and acronyms in the text ("JIPMER", "Tver State Medical University"). */
function phrases(text) {
  const out = new Set();
  const re = /\b(?:[A-Z][\w'&-]*|[A-Z]{2,})(?:\s+(?:of|and|for|&|the|de)?\s*(?:[A-Z][\w'&-]*|[A-Z]{2,}))*/g;
  // Names never run across sentence or clause breaks ("…MBBS. Seats…").
  for (const m of text.split(/[.;:,()!?\n\[\]|]+\s*/).flatMap((part) => [...part.matchAll(re)])) {
    const p = m[0].replace(/[.,']+$/, '').trim();
    const words = p.split(/\s+/);
    if (words.length === 1 && !(/^[A-Z]{3,10}$/.test(p)) ) continue; // single word: acronyms only
    if (words.every((w) => STOP.has(w) || /^(of|and|for|&|the|de)$/.test(w))) continue;
    if (p.length >= 3 && p.length <= 80) out.add(p);
  }
  return [...out].slice(0, 25);
}

/** Exact college/course match for a phrase: same name, an alias, or the [ACRONYM] in the name (only if one college has it). */
const INSTITUTION = /\b(university|college|institute|institution|school|academy|hospital|aiims|iit|nit|iiit|iim)\b/i;
async function lookup(collection, phrase) {
  // A college is only linked from its own kind of name ("Tver State Medical University", "JIPMER"),
  // never from a place name that happens to be saved as an alias ("Tamil Nadu").
  if (collection === 'colleges' && !INSTITUTION.test(phrase) && !/^[A-Z]{3,10}$/.test(phrase)) return null;
  const j = await cmsGet(`/${collection}?${qs({ 'where[or][0][name][like]': phrase, 'where[or][1][alsoKnownAs][like]': phrase, limit: 8, depth: 0, sort: '-popularityScore' })}`).catch(() => ({ docs: [] }));
  const p = norm(phrase);
  const exact = j.docs.filter((d) => norm(d.name) === p || (d.alsoKnownAs || []).some((a) => norm(a) === p));
  if (exact.length) return exact[0];
  const acro = j.docs.filter((d) => new RegExp(`\\[${esc(phrase)}\\]`, 'i').test(d.name));
  return collection === 'courses' ? acro[0] || null : acro.length === 1 ? acro[0] : null;
}

/**
 * Links to add for this text: [{ text, url }] — the first mention of each SYU exam/college/course, most specific first.
 * skipUrls: pages already linked in the doc or the page itself.
 */
export async function findLinks(text, { skipUrls = [] } = {}) {
  const skip = new Set(skipUrls.map((u) => u.replace(/\/$/, '')));
  const found = [];
  const taken = []; // [start, end] ranges already used, so "NEET PG" is not linked inside "NEET PG Counselling"
  const free = (i, len) => !taken.some(([a, b]) => i < b && i + len > a);
  const add = async (name, type, number, id) => {
    const m = new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`, /^[A-Z0-9 ]+$/.test(name) ? '' : 'i').exec(text);
    if (!m || !free(m.index, name.length) || found.length >= MAX_LINKS) return;
    const url = await liveUrl(type, number, id);
    if (!url) return;
    taken.push([m.index, m.index + name.length]); // even when not linked here, a shorter name inside it ("NEET" in "NEET PG") must not be
    if (skip.has(url) || found.some((f) => f.url === url)) return;
    found.push({ text: m[0], url });
  };
  for (const e of await exams()) {
    if (found.length >= MAX_LINKS) break;
    if (new RegExp(`(?<![\\w-])${esc(e.name)}(?![\\w-])`, /^[A-Z0-9 ]+$/.test(e.name) ? '' : 'i').test(text)) await add(e.name, 'exam', e.number);
  }
  for (const p of phrases(text)) {
    if (found.length >= MAX_LINKS) break;
    if (taken.some(([a, b]) => text.indexOf(p) >= a && text.indexOf(p) < b)) continue;
    const college = await lookup('colleges', p);
    if (college) { await add(p, 'college', college.number, college.id); continue; }
    const course = await lookup('courses', p);
    if (course) await add(p, 'course', course.number);
  }
  return found;
}

const TOPIC_STOP = new Set(['the', 'and', 'for', 'of', 'in', 'to', 'on', 'at', 'is', 'out', 'check', 'released', 'release', 'latest', 'news', 'update', 'updates',
  'list', 'details', 'date', 'dates', 'how', 'what', 'all', 'new', 'from', 'with', 'here', 'download', 'pdf', 'out', 'today', 'tomorrow', 'closes', 'window']);
const topicWords = (s) => [...new Set(norm(s).split(' ').filter((w) => w.length >= 2 && !TOPIC_STOP.has(w) && !/^(19|20)\d\d$/.test(w)))];

/**
 * Related published blogs for "Don't Miss": found by the title's leading words, then kept only when they share
 * at least two topic words with this article (so "TN NEET PG" never pulls in "AIIMS Patna"); best match first.
 */
export async function relatedBlogs(topic, { skipUrls = [], count = 3 } = {}) {
  const skip = new Set(skipUrls.map((u) => u.replace(/\/$/, '')));
  const words = topicWords(String(topic).split(/[:|–—]| - /)[0]);
  const mine = new Set(topicWords(topic));
  const pool = new Map();
  for (let n = Math.min(3, words.length); n >= 2; n--) {
    const j = await cmsGet(`/blogPages?${qs({ 'where[title][like]': words.slice(0, n).join(' '), 'where[status][equals]': 'published', limit: 20, depth: 0, sort: '-createdAt' })}`).catch(() => ({ docs: [] }));
    for (const b of j.docs) {
      const url = `${SITE}/blog/${b.pageUrl}`;
      const score = topicWords(b.title).filter((w) => mine.has(w)).length;
      if (score >= 2 && !skip.has(url) && !pool.has(url)) pool.set(url, { text: b.title, url, score });
    }
    if (pool.size >= count * 2) break;
  }
  return [...pool.values()].sort((a, b) => b.score - a.score).slice(0, count).map(({ text, url }) => ({ text, url }));
}
