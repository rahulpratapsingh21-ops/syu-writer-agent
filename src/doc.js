import * as cheerio from 'cheerio';

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

function renderList($, el, fmt) {
  const tag = el.tagName === 'ol' ? 'ol' : 'ul';
  const items = $(el).children('li').toArray().map((li, i) => `<li value="${i + 1}" class="editor-listitem">${renderRuns(runsOf($, li, fmt))}</li>`);
  return `<${tag} class="editor-list-${tag}">${items.join('')}</${tag}>`;
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
/** Fetch and convert one Google Doc: { h1, html, excerpt, stats, warnings } */
export async function convertDoc(docUrl) {
  const id = docIdFrom(docUrl);
  const r = await fetch(`https://docs.google.com/document/d/${id}/export?format=html`);
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
    if (tag === 'ul' || tag === 'ol') { blocks.push({ kind: 'list', html: renderList($, el, fmt), runs: $(el).children('li').toArray().flatMap((li) => runsOf($, li, fmt)) }); stats.lists++; continue; }
    const runs = runsOf($, el, fmt);
    const t = runsText(runs);
    if (!t) continue; // empty lines and image-only paragraphs (e.g. AI-detector screenshots) are dropped
    if (/^h[1-2]$/.test(tag) || /\btitle\b/.test(cls)) blocks.push({ kind: 'h2', text: t });
    else if (/^h[3-6]$/.test(tag) || /\bsubtitle\b/.test(cls)) blocks.push({ kind: 'h3', text: t });
    else blocks.push({ kind: 'p', runs, text: t });
  }

  // FAQ section = from a heading containing "FAQ" / "Frequently asked" to the next h2 (or the end).
  const faqAt = blocks.findIndex((b) => /^h[23]$/.test(b.kind) && /\bfaqs?\b|frequently asked/i.test(b.text));
  const faqEnd = faqAt < 0 ? -1 : (() => { const n = blocks.findIndex((b, i) => i > faqAt && b.kind === 'h2'); return n < 0 ? blocks.length : n; })();

  // CTAs: one before the 3rd section heading (2nd if the article is short), one before the FAQ (or at the end).
  const topic = [h1, ...blocks.filter((b) => b.kind === 'h2').map((b) => b.text)].join(' ');
  const [cta1, cta2] = ctaTexts(topic);
  const h2s = blocks.map((b, i) => (b.kind === 'h2' && (faqAt < 0 || i < faqAt) ? i : -1)).filter((i) => i >= 0);
  const cta1At = h2s.length >= 3 ? h2s[2] : h2s.length === 2 ? h2s[1] : -1;
  const cta2At = faqAt >= 0 ? faqAt : blocks.length;

  let html = '', firstPara = '';
  for (let i = 0; i <= blocks.length; i++) {
    if (i === cta1At) { html += ctaBlock(cta1); stats.ctas++; }
    if (i === cta2At && cta2At !== cta1At) { html += ctaBlock(cta2); stats.ctas++; }
    const b = blocks[i];
    if (!b) break;
    if (b.runs) for (const x of b.runs) if (x.href) { stats.links++; if (/selectyouruniversity\.com/.test(x.href)) stats.internalLinks++; }
    if (i > faqAt && i < faqEnd) continue; // FAQ body is rendered below
    if (b.kind === 'h2') { html += heading(2, b.text); stats.h2++; }
    else if (b.kind === 'h3') html += heading(3, b.text);
    else if (b.kind === 'p') { html += para(b.runs); if (!firstPara) firstPara = b.text; }
    else html += b.html;
    if (i === faqAt) html += renderFaq(blocks.slice(faqAt + 1, faqEnd), stats, warnings);
  }
  stats.words = $('body').text().split(/\s+/).filter(Boolean).length;
  if (stats.imagesSkipped) warnings.push(`${stats.imagesSkipped} image(s) in the doc were not uploaded (e.g. AI-detector screenshot)`);
  if (faqAt < 0) warnings.push('No FAQ section found (a heading with "FAQs")');
  return { docId: id, h1, html, excerpt: excerptOf(firstPara), stats, warnings };
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
