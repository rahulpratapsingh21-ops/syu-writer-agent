import { cmsGet, qs } from './cms.js';

// Content source other than a Google Doc: an existing published SYU college / exam / course page.
// Its sections and FAQs are read from the CMS and laid out like a doc (Title, H2 per section, FAQs),
// so the normal converter can use it. Used for testing and for copying content between pages.

const TYPES = { college: ['colleges', 'collegePages', 'cid'], exam: ['exams', 'examPages', 'eid'], course: ['courses', 'coursePages', 'mci'] };
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const isSyuPage = (url) => /^https?:\/\/(www\.)?selectyouruniversity\.com\/(college|exam|course)\//.test(String(url || ''));

/** "https://www.selectyouruniversity.com/course/master-of-business-administration-mba-mci-100453" → doc-like HTML. */
export async function syuPageAsDoc(url) {
  const [type, slug, seg] = new URL(url).pathname.split('/').filter(Boolean);
  const [entities, pages, code] = TYPES[type];
  const number = slug.match(new RegExp(`-${code}-(\\d+)$`))?.[1];
  if (!number) throw new Error(`Could not read the ${type} number from ${url}`);
  const entity = (await cmsGet(`/${entities}?${qs({ 'where[number][equals]': number, limit: 1, depth: 0 })}`)).docs[0];
  if (!entity) throw new Error(`No ${type} with number ${number} in the CMS`);
  const key = seg ? camel(seg) : 'overview';
  const page = (await cmsGet(`/${pages}?${qs({ 'where[dataRef.value][equals]': entity.id, 'where[page][equals]': key, 'where[status][equals]': 'published', limit: 1, depth: 0 })}`)).docs[0];
  if (!page?.[key]) throw new Error(`No published "${key}" page for ${entity.name}`);

  let html = `<p class="title">${esc(page.pageDisplayTitle || entity.name)}</p>`;
  const faqs = [];
  for (const [k, sec] of Object.entries(page[key])) {
    if (!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    const body = (sec.content?.html || '').replace(/<table>(?:(?!<\/table>).)*syu-leads-form(?:(?!<\/table>).)*<\/table>/gs, ''); // its CTAs are added again
    // data-section: which CMS section this part comes from, so headings inside a section never start a new one.
    if (sec.sectionDisplayTitle && body.trim()) html += `<h2 data-section="${k}">${esc(sec.sectionDisplayTitle)}</h2>${body}`;
    faqs.push(...(sec.faqsContent?.faqs || []));
  }
  faqs.push(...(page[key].faqsContent?.faqs || []));
  if (faqs.length) html += '<h2>FAQs</h2>' + faqs.map((f) => `<h3>${esc(f.question.trim().replace(/\??$/, '?'))}</h3>${f.content?.html || ''}`).join('');
  return `<html><head><style></style></head><body>${html}</body></html>`;
}
