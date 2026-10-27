import * as cheerio from 'cheerio';
import { findLinks, relatedBlogs } from './interlink.js';

// Google Doc (shared "Anyone with the link") → HTML in the exact markup the CMS editor produces.

export const LEAD_FORM = 'https://lp.selectyouruniversity.com/syu-leads-form/';
const TABLE_WIDTH = 1580; // full editor width in px; split equally between columns (= 100% wide, same-size columns)
const TH_STYLE = 'width: 75px; background-color: rgb(242, 243, 245); border: 1px solid black; vertical-align: top; text-align: start;';
const TD_STYLE = 'width: 75px; border: 1px solid black; vertical-align: top; text-align: start;';
const EMPTY_P = '<p class="editor-paragraph"><br></p>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s) => String(s).replace(/ /g, ' ');

export function docIdFrom(url) {
  const id = String(url || '').match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/)?.[1];
  if (!id) throw new Error('Doc URL is not a Google Docs link');
  return id;
}

/** Google wraps every link as https://www.google.com/url?q=<real link>&sa=… */
function realHref(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || href;
  } catch {}
  return href;
}

// ---- inline text: runs of { text, bold, italic, href } -------------------------------------
function runsOf($, el, fmt) {
  const out = [];
  const walk = (node, href) => {
    if (node.type === 'text') { if (node.data) out.push({ text: clean(node.data), href }); return; }
    if (node.type !== 'tag' || node.name === 'img') return;
    if (node.name === 'br') { out.push({ text: '\n', href }); return; }
    const h = node.name === 'a' && $(node).attr('href') ? realHref($(node).attr('href')) : href;
    const before = out.length;
    for (const c of node.children || []) walk(c, h);
    const cls = ($(node).attr('class') || '').split(/\s+/);
    for (let i = before; i < out.length; i++) {
      if (cls.some((c) => fmt.bold.has(c))) out[i].bold = true;
      if (cls.some((c) => fmt.italic.has(c))) out[i].italic = true;
    }
  };
  for (const c of el.children || []) walk(c, null);
  // merge neighbours with the same formatting
  const merged = [];
  for (const r of out) {
    const p = merged[merged.length - 1];
    if (p && p.bold === r.bold && p.italic === r.italic && p.href === r.href) p.text += r.text; else merged.push({ ...r });
  }
  return merged;
}
const runsText = (runs) => runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();

/** Remove a leading prefix (e.g. "Ques:", "Ans:") from runs. */
function stripPrefix(runs, re) {
  const out = runs.map((r) => ({ ...r }));
  while (out.length && !out[0].text.trim()) out.shift();
  if (out.length) out[0].text = out[0].text.replace(/^\s+/, '').replace(re, '').replace(/^\s+/, '');
  return out.filter((r) => r.text);
}

function renderRuns(runs) {
  let html = '';
  for (let i = 0; i < runs.length;) {
    const href = runs[i].href;
    let j = i, inner = '';
    for (; j < runs.length && runs[j].href === href; j++) {
      const r = runs[j];
      for (const [k, part] of r.text.split('\n').entries()) {
        if (k) inner += '<br>';
        if (!part) continue;
        const t = esc(part);
        inner += r.bold ? `<b><strong class="editor-text-bold" style="white-space: pre-wrap;">${t}</strong></b>`
          : r.italic ? `<i><em class="editor-text-italic" style="white-space: pre-wrap;">${t}</em></i>`
          : `<span style="white-space: pre-wrap;">${t}</span>`;
      }
    }
    html += href ? `<a href="${esc(href)}" rel="noreferrer" class="editor-link">${inner}</a>` : inner;
    i = j;
  }
  return html;
}

const para = (runs) => `<p class="editor-paragraph" dir="ltr">${renderRuns(runs)}</p>`;
const heading = (level, text) => `<h${level} class="editor-heading-h${level}" dir="ltr"><span style="white-space: pre-wrap;">${esc(text)}</span></h${level}>`;

/** List block: items stay as runs (so links can still be added); html is rendered when read. */
function listBlock($, el, fmt) {
  const tag = el.tagName === 'ol' ? 'ol' : 'ul';
  const items = $(el).children('li').toArray().map((li) => runsOf($, li, fmt));
  return {
    kind: 'list', tag, items,
    get runs() { return this.items.flat(); },
    get html() { return `<${this.tag} class="editor-list-${this.tag}">${this.items.map((r, i) => `<li value="${i + 1}" class="editor-listitem">${renderRuns(r)}</li>`).join('')}</${this.tag}>`; },
  };
}

function renderTable($, el, fmt) {
  const rows = $(el).find('tr').toArray();
  const cols = Math.max(...rows.map((tr) => $(tr).children('td,th').toArray().reduce((n, c) => n + Number($(c).attr('colspan') || 1), 0)));
  const w = Math.floor(TABLE_WIDTH / cols);
  const body = rows.map((tr, r) => `<tr>${$(tr).children('td,th').toArray().map((cell) => {
    const tag = r === 0 ? 'th' : 'td'; // first row = header row
    const ps = $(cell).children('p').toArray().map((p) => runsOf($, p, fmt)).filter((x) => runsText(x));
    const span = ['colspan', 'rowspan'].map((a) => (Number($(cell).attr(a) || 1) > 1 ? ` ${a}="${$(cell).attr(a)}"` : '')).join('');
    return `<${tag}${span} style="${r === 0 ? TH_STYLE : TD_STYLE}">${(ps.length ? ps : [[]]).map(para).join('')}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table style="width: 100%;"><colgroup>${`<col style="width: ${w}px;">`.repeat(cols)}</colgroup><tbody>${body}</tbody></table>`;
}

// ---- CTA -----------------------------------------------------------------------------------
const CTA_RULES = [
  [/counsel+ing|seat matrix|seat allot|choice fill|merit list|round \d|mop.?up/i, '☎️ Confused About Counselling? Talk to an Expert Counsellor — FREE Call ☎️'],
  [/admit card|result|cut ?off|score ?card|rank|answer key/i, '📊 Check Your Admission Chances — Talk to an Expert, FREE ☎️'],
  [/admission|apply|application|registration|form/i, '🎓 Need Help with Admission? Get FREE Expert Guidance ☎️'],
  [/abroad|russia|georgia|kazakhstan|uzbekistan|kyrgyzstan|philippines|nepal|bangladesh|vietnam/i, '🌍 Planning to Study Abroad? Talk to an Expert Counsellor — FREE ☎️'],
  [/mbbs|neet|medical|bds|ayush/i, '🩺 Want an MBBS Seat? Get FREE Expert Counselling ☎️'],
  [/college|university|institute/i, '🏫 Find the Right College — Talk to an Expert, FREE ☎️'],
];
const CTA_DEFAULT = '☎️ Talk to an Expert Counsellor — FREE Call ☎️';
const CTA_ALT = '📞 Get FREE Personalised Guidance — Book a Call Now ☎️';
/** Two CTAs picked from the title and headings: one matching the topic, then the standard one. */
export function ctaTexts(topicText) {
  const first = CTA_RULES.find(([re]) => re.test(topicText))?.[1] || CTA_DEFAULT;
  return [first, first === CTA_DEFAULT ? CTA_ALT : CTA_DEFAULT];
}
export const ctaBlock = (text) => `${EMPTY_P}<table><colgroup><col style="width: ${TABLE_WIDTH}px;"></colgroup><tbody><tr><th style="${TH_STYLE}"><h2 style="text-align: center;" class="editor-heading-h2"><span style="white-space: pre-wrap;"> </span><a class="editor-link" rel="noreferrer" href="${LEAD_FORM}"><span style="white-space: pre-wrap;">${esc(text)}</span></a></h2></th></tr></tbody></table>${EMPTY_P}`;

// ---- FAQ -----------------------------------------------------------------------------------
const Q_RE = /^(q(ues(tion)?)?\s*\.?\s*\d*\s*[:.)\-–]\s*)/i;
const A_RE = /^(a(ns(wer)?)?\s*\.?\s*\d*\s*[:.)\-–]\s*)/i;
const isQuestion = (t) => Q_RE.test(t) || (/\?$/.test(t) && !A_RE.test(t) && t.length < 220);

// ---- main ----------------------------------------------------------------------------------
/**
 * Fetch one Google Doc (only the tab in the link, if any) and split it into blocks, with SYU interlinks added:
 * { id, h1, blocks, faqAt, faqEnd, stats, warnings, autoLinks }
 */
async function readDoc(docUrl, { selfUrl = '' } = {}) {
  const id = docIdFrom(docUrl);
  const tab = String(docUrl).match(/[?&#]tab=(t\.[\w-]+)/)?.[1];
  const r = await fetch(`https://docs.google.com/document/d/${id}/export?format=html${tab ? `&tab=${tab}` : ''}`);
  const text = await r.text();
  if (!r.ok || !/<html/i.test(text.slice(0, 500))) throw new Error('Could not open the Google Doc. Share it as "Anyone with the link" (Viewer).');
  const $ = cheerio.load(text);
  const css = $('style').text();
  const classes = (re) => new Set([...css.matchAll(/\.(c\d+)\{([^}]*)\}/g)].filter((m) => re.test(m[2])).map((m) => m[1]));
  const fmt = { bold: classes(/font-weight:\s*(700|bold)/), italic: classes(/font-style:\s*italic/) };

  const warnings = [];
  const stats = { words: 0, h2: 0, tables: 0, lists: 0, links: 0, internalLinks: 0, faqs: 0, ctas: 0, imagesSkipped: $('img').length };
  const els = $('body').children().toArray();

  // H1 = the doc's Title line (first "title"-styled paragraph); fallback: first heading.
  let h1 = '', h1Index = -1;
  for (const [i, el] of els.entries()) {
    const t = runsText(runsOf($, el, fmt));
    if (!t) continue;
    if ((/\btitle\b/.test($(el).attr('class') || '') || el.tagName === 'h1') && !h1) { h1 = t; h1Index = i; }
    break;
  }
  if (!h1) warnings.push('No Title line at the top of the doc — use the sheet Title as H1');

  // Build blocks: { kind: 'h2'|'h3'|'p'|'list'|'table', html, text }
  const blocks = [];
  for (const [i, el] of els.entries()) {
    if (i === h1Index) continue;
    const tag = el.tagName, cls = $(el).attr('class') || '';
    if (tag === 'table') { blocks.push({ kind: 'table', html: renderTable($, el, fmt) }); stats.tables++; continue; }
    if (tag === 'ul' || tag === 'ol') { blocks.push(listBlock($, el, fmt)); stats.lists++; continue; }
    const runs = runsOf($, el, fmt);
    const t = runsText(runs);
    if (!t) continue; // empty lines and image-only paragraphs (e.g. AI-detector screenshots) are dropped
    if (/^https?:\/\/\S+$/.test(t)) { stats.sourcesSkipped = (stats.sourcesSkipped || 0) + 1; continue; } // bare source links (research notes)
    if (/^h[1-2]$/.test(tag) || /\btitle\b/.test(cls)) blocks.push({ kind: 'h2', text: t });
    else if (/^h[3-6]$/.test(tag) || /\bsubtitle\b/.test(cls)) blocks.push({ kind: 'h3', text: t });
    else blocks.push({ kind: 'p', runs, text: t });
  }

  // FAQ section = from a heading containing "FAQ" / "Frequently asked" to the next h2 (or the end).
  const faqAt = blocks.findIndex((b) => /^h[23]$/.test(b.kind) && /\bfaqs?\b|frequently asked/i.test(b.text));
  const faqEnd = faqAt < 0 ? -1 : (() => { const n = blocks.findIndex((b, i) => i > faqAt && b.kind === 'h2'); return n < 0 ? blocks.length : n; })();
  stats.words = $('body').text().split(/\s+/).filter(Boolean).length;
  if (stats.imagesSkipped) warnings.push(`${stats.imagesSkipped} image(s) in the doc were not uploaded (e.g. AI-detector screenshot)`);
  if (stats.sourcesSkipped) warnings.push(`${stats.sourcesSkipped} bare source link line(s) were not uploaded (research notes)`);

  // Interlinks: link the first mention of SYU exams / colleges / courses (normal text only, not headings or questions).
  // (Short all-lowercase lines are writers' keyword notes, which are not uploaded.)
  const linkable = blocks.filter((b) => (b.kind === 'p' && !/\?$/.test(b.text) && !(b.text === b.text.toLowerCase() && b.text.split(/\s+/).length <= 8)) || b.kind === 'list');
  const existing = blocks.flatMap((b) => (b.runs || []).filter((x) => x.href).map((x) => x.href));
  const plain = linkable.map((b) => (b.kind === 'list' ? b.items.map(runsText).join('\n') : b.text)).join('\n');
  const autoLinks = [];
  try {
    for (const l of await findLinks(plain, { skipUrls: [...existing, selfUrl].filter(Boolean) })) {
      const lists = linkable.flatMap((b) => (b.kind === 'list' ? b.items : [b.runs]));
      if (lists.some((runs) => linkFirst(runs, l.text, l.url))) autoLinks.push(l);
    }
  } catch (e) { warnings.push(`Interlinks could not be added: ${e.message}`); }
  for (const b of blocks) if (b.runs) for (const x of b.runs) if (x.href) { stats.links++; if (/selectyouruniversity\.com/.test(x.href)) stats.internalLinks++; }
  stats.autoLinks = autoLinks.length;
  if (faqAt < 0) warnings.push('No FAQ section found (a heading with "FAQs")');
  const docText = [h1, ...blocks.map((b) => (b.kind === 'list' ? b.items.map(runsText).join(' ') : b.text || ''))].join(' ');
  return { id, h1, blocks, faqAt, faqEnd, stats, warnings, autoLinks, docText };
}

/** Link the first plain-text occurrence of phrase inside one run (split the run around it). */
function linkFirst(runs, phrase, url) {
  const re = new RegExp(`(?<![\\w-])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.href) continue;
    const m = re.exec(r.text);
    if (!m) continue;
    const parts = [];
    if (m.index) parts.push({ ...r, text: r.text.slice(0, m.index) });
    parts.push({ ...r, text: m[0], href: url });
    if (m.index + m[0].length < r.text.length) parts.push({ ...r, text: r.text.slice(m.index + m[0].length) });
    runs.splice(i, 1, ...parts);
    return true;
  }
  return false;
}

/** "Don't Miss:" box like the SYU blogs: a bold label and a list of bold links to related blogs. */
const dontMiss = (links) => `<p class="editor-paragraph" dir="ltr"><b><strong class="editor-text-bold" style="white-space: pre-wrap;">Don't Miss:</strong></b></p><ul class="editor-list-ul">${links
  .map((l, i) => `<li value="${i + 1}" class="editor-listitem"><a href="${esc(l.url)}" rel="noreferrer" class="editor-link"><b><strong class="editor-text-bold" style="white-space: pre-wrap;">${esc(l.text)}</strong></b></a></li>`).join('')}</ul>`;

/** Blog: fetch and convert one Google Doc into one HTML body: { h1, html, excerpt, stats, warnings } */
export async function convertDoc(docUrl, { selfUrl = '', title = '' } = {}) {
  const { id, h1, blocks, faqAt, faqEnd, stats, warnings, autoLinks } = await readDoc(docUrl, { selfUrl });

  // CTAs: one before the 3rd section heading (2nd if the article is short), one before the FAQ (or at the end).
  const topic = [h1, ...blocks.filter((b) => b.kind === 'h2').map((b) => b.text)].join(' ');
  const [cta1, cta2] = ctaTexts(topic);
  const h2s = blocks.map((b, i) => (b.kind === 'h2' && (faqAt < 0 || i < faqAt) ? i : -1)).filter((i) => i >= 0);
  const cta1At = h2s.length >= 3 ? h2s[2] : h2s.length === 2 ? h2s[1] : -1;
  const cta2At = faqAt >= 0 ? faqAt : blocks.length;

  // "Don't Miss:" related blogs, before the last section ahead of the FAQ (not right next to a CTA).
  const existing = new Set(blocks.flatMap((b) => (b.runs || []).filter((x) => x.href).map((x) => x.href.replace(/\/$/, ''))));
  const related = await relatedBlogs(h1 || title, { skipUrls: [...existing, selfUrl] }).catch(() => []);
  const dmAt = [...h2s].reverse().find((i) => i !== cta1At && i !== h2s[0]) ?? cta2At;
  stats.relatedBlogs = related.length;

  let html = '', firstPara = '';
  for (let i = 0; i <= blocks.length; i++) {
    if (i === dmAt && related.length) html += dontMiss(related) + EMPTY_P;
    if (i === cta1At) { html += ctaBlock(cta1); stats.ctas++; }
    if (i === cta2At && cta2At !== cta1At) { html += ctaBlock(cta2); stats.ctas++; }
    const b = blocks[i];
    if (!b) break;
    if (i > faqAt && i < faqEnd) continue; // FAQ body is rendered below
    if (b.kind === 'h2') { html += heading(2, b.text); stats.h2++; }
    else if (b.kind === 'h3') html += heading(3, b.text);
    else if (b.kind === 'p') { html += para(b.runs); if (!firstPara) firstPara = b.text; }
    else html += b.html;
    if (i === faqAt) html += renderFaq(blocks.slice(faqAt + 1, faqEnd), stats, warnings);
  }
  return { docId: id, h1, html, excerpt: excerptOf(firstPara), stats, warnings, autoLinks, related };
}

/** Render a run of blocks (no FAQ handling) as editor HTML. */
const renderBlocks = (blocks) => blocks.map((b) => (b.kind === 'h2' ? heading(2, b.text) : b.kind === 'h3' ? heading(3, b.text) : b.kind === 'p' ? para(b.runs) : b.html)).join('');

/** FAQ blocks → [{ question, html }] (answer without the "Ans:" prefix). */
function faqItems(blocks) {
  const items = [];
  for (const b of blocks) {
    const t = b.text || '';
    if (b.kind !== 'list' && b.kind !== 'table' && isQuestion(t)) items.push({ question: t.replace(Q_RE, '').trim(), html: '' });
    else if (!items.length) continue;
    else if (b.kind === 'p') items[items.length - 1].html += para(A_RE.test(t) ? stripPrefix(b.runs, A_RE) : b.runs);
    else items[items.length - 1].html += b.kind === 'h3' ? heading(3, t) : b.html;
  }
  return items.filter((x) => x.html);
}

// ---- silo pages (college / exam / course) ---------------------------------------------------
// A silo page is a set of named sections ({ sectionDisplayTitle, showOnWebsite, content: { html }, faqsContent? })
// plus, on some pages, a page-level FAQ list. In the writers' docs a section starts with a short plain line
// ("Overview", "Courses and Fees", "Admission") or an H2 naming it. Other short lines and H2s become headings inside
// the current section. Each section can have its own FAQ ("FAQs (5)" followed by questions).
const SECTION_ALIASES = {
  overview: /\b(overview|about|introduction|highlights?)\b/i, summary: /\bsummary\b/i,
  programs: /\b(courses? (and|&) fees?|programs?|programmes?|courses offered)\b/i, allPrograms: /\b(courses? offered|programs?|programmes?|all courses)\b/i,
  feeStructure: /\bfees? structure|fees?\b/i, fees: /\bfees?\b|\bcost\b/i, eligibility: /\beligib/i,
  admissions: /\badmissions?\b/i, applicationProcess: /\bapplication process|how to apply\b/i, cutOff: /\bcut ?-?offs?\b/i,
  curriculum: /\b(curriculum|syllabus|subjects)\b/i, scholarship: /\bscholarships?\b/i, scholarships: /\bscholarships?\b/i,
  scholarshipAndFunding: /\b(scholarships?|funding)\b/i, listOfScholarships: /\b(list of scholarships|scholarships offered|types of scholarships)\b/i,
  placements: /\bplacements?|recruiters?\b/i, faculty: /\bfaculty|teachers?|professors?\b/i,
  infrastructure: /\binfrastructure|campus|facilities\b/i, campusHighlights: /\bcampus highlights?\b/i, hostel: /\bhostels?|dormitor(y|ies)\b/i,
  hostelFee: /\bhostel fees?|hostel cost|dormitory fees?|accommodation (fee|cost)\b/i, hostelLife: /\bhostel life|student life\b/i,
  library: /\blibrary\b/i, sportsFacilities: /\bsports?\b/i,
  // exam pages
  whatIsNew: /\bwhat'?s new|latest (updates?|news)\b/i, examDetails: /\bexam (details|highlights|pattern)\b/i,
  examDates: /\b(dates?|schedule|calendar|time ?table)\b/i, syllabus: /\bsyllabus\b/i, subjectSyllabus: /\bsyllabus\b/i,
  questionPapers: /\b(question papers?|previous year|sample papers?|pyqs?)\b/i, pastQuestionPapers: /\b(question papers?|previous year|sample papers?|pyqs?)\b/i,
  examCenters: /\bexam cent(er|re)s?|test cent(er|re)s?\b/i, admitCard: /\badmit card|hall ticket\b/i, preparation: /\bpreparation|tips|strategy|books\b/i,
  examPattern: /\bpattern|marking scheme\b/i, answerKeys: /\banswer keys?\b/i, cutoff: /\bcut ?-?offs?\b/i,
  counselling: /\bcounsel+ing|seat allotment|choice filling\b/i, moreInfo: /\bmore info|other details\b/i,
  // course pages
  specialisations: /\bspeciali[sz]ations?|branches\b/i, exams: /\bentrance exams?|exams? (accepted|required)\b/i,
  jobsAndCareers: /\bjobs?|careers?|salary|scope\b/i,
};
// More specific sections win when a heading matches several (e.g. "Hostel Fee" → hostelFee, not hostel).
const SPECIFIC = ['hostelFee', 'hostelLife', 'listOfScholarships', 'applicationProcess', 'feeStructure', 'allPrograms', 'campusHighlights', 'sportsFacilities', 'cutOff',
  'admitCard', 'answerKeys', 'examCenters', 'whatIsNew', 'questionPapers', 'pastQuestionPapers', 'subjectSyllabus', 'examPattern', 'counselling', 'cutoff'];

const isSection = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'sectionDisplayTitle' in v && v.content;
const justify = (html) => html.replace(/<p class="editor-paragraph" dir="ltr">/g, '<p class="editor-paragraph" dir="ltr" style="text-align: justify;">');

// Writers' doc conventions.
const NUM_Q = /^\s*(\d+\s*[.)]\s*|q(ues(tion)?)?\s*\.?\s*\d*\s*[:.)\-–]\s*)/i;
const isLabel = (b) => b.kind === 'h2' || (b.kind === 'p' && b.text.length <= 60 && b.text.split(/\s+/).length <= 6 && !/[.?!,;:]$/.test(b.text) && !b.runs.some((r) => r.href));
const isKeywordNote = (b) => b.kind === 'p' && b.text === b.text.toLowerCase() && b.text.split(/\s+/).length <= 8 && !/[.?!]$/.test(b.text);
const isFaqLabel = (b) => b.kind !== 'list' && b.kind !== 'table' && b.text.length < 50 && /^(faqs?|frequently asked questions?)\b/i.test(b.text);
const isQ = (b) => b.kind !== 'list' && b.kind !== 'table' && /\?\s*$/.test(b.text) && b.text.length < 250;

/**
 * Silo: convert a Google Doc into the silo's sections + FAQ lists, starting from the draft's current silo object.
 * inOrder = true (course pages): each section line / H2 fills the next section in order, whatever its name.
 */
export async function convertSilo(docUrl, silo, { inOrder = false, selfUrl = '' } = {}) {
  const { id, h1, blocks, stats, warnings: readWarnings, autoLinks, docText } = await readDoc(docUrl, { selfUrl });
  const warnings = readWarnings.filter((w) => !/^No FAQ section found|^No Title line/.test(w));
  const out = structuredClone(silo || {});
  const keys = Object.keys(out).filter((k) => isSection(out[k]));
  if (!keys.length) throw new Error('This silo page has no sections in the CMS that text can go into');

  const used = new Set();
  // Section by name; on course pages (inOrder) an H2 that names no section takes the next free one in order.
  const match = (text, kind) => {
    const hits = keys.filter((k) => !used.has(k) && SECTION_ALIASES[k]?.test(text));
    const named = hits.find((k) => SPECIFIC.includes(k)) || hits[0] || null;
    if (named || !inOrder || kind !== 'h2') return named;
    return keys.find((k) => !used.has(k)) || null;
  };

  // Walk the doc: sections, headings inside them, and each section's FAQs.
  const parts = [{ key: null, title: null, blocks: [], faqs: [] }];
  let cur = parts[0], faqMode = false, afterLabel = false;
  stats.notesSkipped = 0;
  for (const b of blocks) {
    if (afterLabel && isKeywordNote(b)) { stats.notesSkipped++; continue; } // keyword notes under a section line
    afterLabel = false;
    if (isFaqLabel(b)) { faqMode = true; continue; }
    if (isQ(b) && (faqMode || NUM_Q.test(b.text) || b.kind === 'h3')) { faqMode = true; cur.faqs.push({ question: b.text.replace(NUM_Q, '').trim(), blocks: [] }); continue; }
    if (faqMode && cur.faqs.length && !isLabel(b)) { cur.faqs[cur.faqs.length - 1].blocks.push(b); continue; }
    if (isLabel(b)) {
      faqMode = false; afterLabel = true;
      const k = match(b.text, b.kind);
      if (k) { used.add(k); cur = { key: k, title: b.kind === 'h2' ? b.text : null, blocks: [], faqs: [] }; parts.push(cur); continue; }
      cur.blocks.push({ kind: b.kind === 'h2' ? 'h2' : 'h3', text: b.text }); // not a section of this page: heading inside the current one
      continue;
    }
    cur.blocks.push(b);
  }
  if (!parts[0].blocks.length && !parts[0].faqs.length) parts.shift();
  else if (!used.has(keys[0])) { parts[0].key = keys[0]; used.add(keys[0]); }
  else { warnings.push('Text before the first section line was added to the first section'); parts[1].blocks.unshift(...parts[0].blocks); parts[1].faqs.unshift(...parts[0].faqs); parts.shift(); }
  if (stats.notesSkipped) warnings.push(`${stats.notesSkipped} keyword note line(s) under section names were not uploaded`);

  // CTAs: one after the middle section and one after the last (one only, after the last, if fewer than 3 sections).
  const [cta1, cta2] = ctaTexts([h1, ...parts.map((p) => p.title || out[p.key]?.sectionDisplayTitle || '')].join(' '));
  const filled = parts.filter((p) => p.key);
  const mid = filled.length >= 3 ? filled[Math.floor((filled.length - 1) / 2)] : null;
  const faqHtml = (f) => f.blocks.map((b) => (b.kind === 'p' ? para(A_RE.test(b.text) ? stripPrefix(b.runs, A_RE) : b.runs) : b.kind === 'h3' ? heading(3, b.text) : b.html)).join('');
  const pageFaqs = [];
  stats.faqs = 0; stats.h2 = 0;
  for (const p of filled) {
    let html = justify(renderBlocks(p.blocks));
    if (p === mid) { html += ctaBlock(cta1); stats.ctas++; }
    if (p === filled[filled.length - 1]) { html += ctaBlock(mid ? cta2 : cta1); stats.ctas++; }
    const sec = out[p.key];
    out[p.key] = { ...sec, ...(p.title ? { sectionDisplayTitle: p.title } : {}), showOnWebsite: true, content: { ...(sec.content || {}), isExpanded: true, html } };
    stats.h2++;
    // FAQs: the section's own list, else the page's list, else as text at the end of the section.
    const list = p.faqs.map((f) => ({ question: f.question, content: { isExpanded: true, html: justify(faqHtml(f)) } })).filter((f) => f.content.html);
    stats.faqs += list.length;
    if (!list.length) continue;
    if (sec.faqsContent) out[p.key].faqsContent = { ...sec.faqsContent, faqs: list };
    else if (out.faqsContent) pageFaqs.push(...list);
    else {
      out[p.key].content.html += heading(2, 'FAQs') + list.map((f) => `<h3 class="editor-heading-h3" dir="ltr"><b><strong class="editor-text-bold" style="white-space: pre-wrap;">Q. ${esc(f.question)}</strong></b></h3>${f.content.html.replace(/^<p([^>]*)>/, '<p$1><b><strong class="editor-text-bold" style="white-space: pre-wrap;">Ans. </strong></b>')}${EMPTY_P}`).join('');
      warnings.push(`${sec.sectionDisplayTitle || p.key}: this page has no FAQ list in the CMS — FAQs were added as text at the end of the section`);
    }
  }
  if (pageFaqs.length) out.faqsContent = { ...out.faqsContent, faqs: pageFaqs };
  if (!stats.faqs) warnings.push('No FAQs found in the doc');

  const untouched = keys.filter((k) => !used.has(k)).map((k) => out[k].sectionDisplayTitle || k);
  const sections = filled.map((p) => ({ key: p.key, title: out[p.key].sectionDisplayTitle, chars: out[p.key].content.html.length, faqs: p.faqs.length }));
  const faqPreview = (list) => list.map((f) => `<h3 class="editor-heading-h3">Q. ${esc(f.question)}</h3>${f.content.html}${EMPTY_P}`).join('');
  const preview = filled.map((p) => heading(2, out[p.key].sectionDisplayTitle) + out[p.key].content.html
    + (out[p.key].faqsContent?.faqs?.length && p.faqs.length ? heading(3, `${out[p.key].sectionDisplayTitle} — FAQs`) + faqPreview(out[p.key].faqsContent.faqs) : '')).join('')
    + (pageFaqs.length ? heading(2, 'FAQs') + faqPreview(pageFaqs) : '');
  return { docId: id, h1, silo: out, sections, untouched, preview, stats, warnings, autoLinks, docText };
}

/** FAQ: "Q. question" as bold h3, "Ans." in bold before the answer, an empty line between questions. */
function renderFaq(blocks, stats, warnings) {
  let html = '', open = false;
  for (const b of blocks) {
    const t = b.text || '';
    if (b.kind !== 'list' && b.kind !== 'table' && isQuestion(t)) {
      if (open) html += EMPTY_P;
      html += `<h3 class="editor-heading-h3" dir="ltr"><b><strong class="editor-text-bold" style="white-space: pre-wrap;">Q. ${esc(t.replace(Q_RE, ''))}</strong></b></h3>`;
      open = true; stats.faqs++;
    } else if (b.kind === 'p' && A_RE.test(t)) {
      html += `<p class="editor-paragraph" dir="ltr"><b><strong class="editor-text-bold" style="white-space: pre-wrap;">Ans. </strong></b>${renderRuns(stripPrefix(b.runs, A_RE))}</p>`;
    } else if (b.kind === 'p') html += para(b.runs);
    else if (b.kind === 'h3') html += heading(3, t);
    else html += b.html;
  }
  if (open) html += EMPTY_P;
  if (!stats.faqs) warnings.push('FAQ heading found, but no questions under it');
  return html;
}

/** First paragraph, cut to 300 characters on a word boundary. */
function excerptOf(text) {
  if (text.length <= 300) return text;
  return text.slice(0, 300).replace(/\s+\S*$/, '');
}
