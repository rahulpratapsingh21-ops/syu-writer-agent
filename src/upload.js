import { cmsGet, qs, savePage, uploadImage } from './cms.js';
import { convertDoc, convertSilo } from './doc.js';
import { makeHero, heroText } from './hero.js';

// Where each content type keeps its page and its draft versions (from the CMS admin code).
const PAGES = {
  blogs: { collection: 'blogPages', versions: '_blogContent_versions' },
  colleges: { collection: 'collegePages', versions: '_collegePages_versions' },
  exams: { collection: 'examPages', versions: '_examPages_versions' },
  courses: { collection: 'coursePages', versions: '_coursePages_versions' },
};
// Draft states a writer may still change; submitted (with the editor), approved or published is left alone.
const EDITABLE = ['draft', 'reOpenedForCW', 'rejected'];
const HAS_CONTENT = 200; // more text than this = the draft already has content

/** Today at midnight India time, as the CMS date picker stores it (e.g. 2026-10-26T18:30:00.000Z for 27 Oct). */
function todayIST() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${d}T00:00:00+05:30`).toISOString();
}

/** Silo field on the page: "overview" → overview, "MBBS:courseDetails" → courseDetails, "General:specialisation" → specialisation. */
const siloKey = (page) => (page.includes(':') ? page.split(':').pop() : page);
const siloName = (page) => page.replace(/:(\w+)$/, (_, k) => ` (${k.replace(/([A-Z])/g, ' $1').toLowerCase()})`);

/** Text length of a draft: the blog html, or all section html of the silo. */
function contentLength(version, category, key) {
  if (category === 'blogs') return (version.html || '').trim().length;
  const walk = (v) => (Array.isArray(v) ? v.reduce((n, x) => n + walk(x), 0)
    : v && typeof v === 'object' ? Object.entries(v).reduce((n, [k, x]) => n + (k === 'html' && typeof x === 'string' ? x.trim().length : walk(x)), 0) : 0);
  return walk(version[key]);
}

/** Pick the subtask a sheet row is about: the blog subtask, the only silo, or the silo whose page URL is in Live URL. */
function pickSubtask(subs, category, liveUrl) {
  if (category === 'blogs') return subs.find((s) => s.page === 'blogContent') || subs[0];
  if (subs.length === 1) return subs[0];
  const last = (() => { try { return new URL(liveUrl).pathname.split('/').filter(Boolean).pop(); } catch { return ''; } })();
  const hit = last && subs.find((s) => s.pageUrl === last);
  if (hit) return hit;
  throw new Error(`This task has ${subs.length} silos (${subs.map((s) => siloName(s.page)).join(', ')}) — put the silo page link in Live URL so the agent knows which one this doc is for`);
}

/**
 * CMS task → the row's subtask → the writer's draft version.
 * A task the writer has not started yet has no draft: with start = true the agent clicks "Start" (as the writer
 * would), which makes the CMS create the draft; otherwise ver is null and notStarted is true.
 */
async function findDraft(taskId, liveUrl, { start = false } = {}) {
  const task = (await cmsGet(`/tasks?${qs({ 'where[taskId][equals]': taskId, limit: 1, depth: 0 })}`)).docs[0];
  if (!task) throw new Error(`Task ${taskId} not found in the CMS`);
  const where = PAGES[task.contentCategory];
  if (!where) throw new Error(`Task ${taskId} is a "${task.contentCategory}" task — not supported`);
  const subs = (await cmsGet(`/subTasks?${qs({ 'where[parentTaskId][equals]': task.id, limit: 50, depth: 0 })}`)).docs;
  if (!subs.length) throw new Error(`Task ${taskId} has no subtask`);
  const sub = pickSubtask(subs, task.contentCategory, liveUrl);
  const base = { task, sub, category: task.contentCategory, key: siloKey(sub.page), collection: where.collection };
  const draft = async () => (await cmsGet(`/${where.versions}?${qs({ 'where[version.subTaskRef][equals]': sub.id, sort: '-updatedAt', limit: 1, depth: 0 })}`)).docs[0];
  let ver = await draft();
  if (!ver && sub.status === 'open') {
    if (!start) return { ...base, ver: null, notStarted: true };
    const { createdAt, updatedAt, ...fields } = sub;
    await savePage('subTasks', sub.id, fields, 'startTaskForCW');
    ver = await draft();
  }
  if (!ver) throw new Error(`Subtask ${sub.subTaskId} (${sub.status}) has no draft — open it in the CMS as the writer and click Start`);
  return { ...base, ver };
}

/**
 * Section layout to preview a silo whose task is not started yet: the published page of the same silo,
 * or (a new page) the same silo type of another entity with its text emptied.
 */
async function siloTemplate({ task, sub, collection, key }) {
  const own = (await cmsGet(`/${collection}?${qs({ 'where[dataRef.value][equals]': task.entity?.value, 'where[page][equals]': sub.page, limit: 1, depth: 0 })}`)).docs[0];
  if (own?.[key]) return own[key];
  const where = sub.page.includes(':') ? { 'where[page][like]': `:${key}` } : { 'where[page][equals]': sub.page };
  const other = (await cmsGet(`/${collection}?${qs({ ...where, limit: 1, depth: 0, sort: '-updatedAt' })}`)).docs[0]?.[key];
  if (!other) return null;
  const blank = (v) => (Array.isArray(v) ? [] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'html' ? '' : k === 'id' ? undefined : blank(x)])) : v);
  return blank(other);
}

const GENERIC_WRITER = /^content\s*writer$/i;
const SITE = 'https://www.selectyouruniversity.com';
const SEG = { colleges: 'college', exams: 'exam', courses: 'course' };
/** The page's own address, so it is never interlinked to itself. */
const selfUrlOf = ({ category, sub }) => (category === 'blogs' ? `${SITE}/blog/${sub.pageUrl}` : sub.page === 'overview' ? `${SITE}/${SEG[category]}/${sub.pageUrl}` : '');

/**
 * Page title (H1) when the doc has no Title line: the page's current title, unless that is only a placeholder
 * ("Overview", which the CMS sets when a task starts) — then the agent writes one in the SYU style for that silo.
 */
function siloTitle(current, sub, category, entity) {
  const placeholder = !current || current.trim().length < 15
    || current.trim().toLowerCase() === siloKey(sub.page).replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  return placeholder ? makeH1(category, sub.page, entity) : current;
}

/** SYU-style H1 for a silo page, e.g. "Muna College of Education, Cuddalore: Admission 2027-28, Courses, Fees, …". */
export function makeH1(category, page, entity) {
  const now = new Date();
  const y = now.getFullYear() + (now.getMonth() >= 8 ? 1 : 0); // from September the next admission cycle is meant
  const yy = `${y}-${String(y + 1).slice(-2)}`;
  // "Muna College of Education - [MCE] ,Cuddalore ,Tamil Nadu" → "Muna College of Education, Cuddalore";
  // "Diploma in Medical Laboratory Technology (DMLT): Full Form" → name before ":", acronym DMLT.
  const [rawName, city] = String(entity || '').split(/\s*:\s*/)[0].split(/\s*,\s*/);
  const name = rawName.replace(/\s*-?\s*[[(][A-Z][^\])]*[\])]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const acronym = (s) => s.match(/\[([^\]]+)\]/)?.[1] || s.match(/\(([A-Z][A-Za-z.&]{1,12})\)/)?.[1];
  const sub = page.includes(':') ? page.split(':')[0] : ''; // course / specialisation name of a sub-page
  const course = acronym(sub) || sub;
  const N = city ? `${name}, ${city}` : name;
  const short = acronym(entity) || name;
  const T = {
    colleges: {
      overview: `${N}: Admission ${yy}, Courses, Fees, Ranking, Placements, Scholarship`,
      coursesAndFees: `${name} Courses & Fees ${y}: Fee Structure, Eligibility & Admission`,
      admissions: `${name} Admission ${yy}: Eligibility, Dates, Application Process`,
      infrastructure: `${name} Infrastructure: Campus, Hostel, Labs & Facilities`,
      scholarship: `${name} Scholarship ${y}: Eligibility, Benefits & Application`,
      placements: `${name} Placements ${y}: Highest & Average Package, Top Recruiters`,
      faculty: `${name} Faculty: Professors, Qualifications & Departments`,
      reviews: `${name} Reviews: Student Ratings for Courses, Placements & Campus`,
      gallery: `${name} Gallery: Campus, Hostel & Infrastructure Photos`,
      newsAndArticles: `${short} News and Latest Updates ${y}`,
      courseDetails: `${name} ${course}: Fees, Eligibility & Admission ${yy}`,
      courseSpecialisation: `${name} ${course}: Fees, Eligibility, Cut Off & Placements`,
    },
    exams: {
      overview: `${short} ${y}: Exam Date, Application Process, Admit Card, Syllabus, Pattern, Result`,
      examDates: `${short} Exam Date ${y}: Admit Card, Result & Counselling Dates`,
      applicationProcess: `${short} Application Form ${y}: Dates, Fees & Process`,
      eligibilityAndPreparation: `${short} ${y} Eligibility, Syllabus & Preparation Strategy`,
      examDetails: `${short} ${y} Exam Details: Date, Pattern, Merit List, Old Question Papers and Answer Keys`,
      results: `${short} Result ${y}: Release Date, Scorecard, Cutoff & Merit List`,
      syllabus: `${short} Syllabus ${y}: Subject-wise Topics & PDF Download`,
      pastQuestionPapers: `${short} Previous Year Question Papers: Download PDFs with Solutions`,
      acceptingColleges: `${short} Accepting Colleges ${y}: List of Colleges, Cutoff & Fees`,
    },
    courses: {
      overview: `${short} Course ${y}: Full Form, Admission, Eligibility, Entrance Exams, Top Colleges, Fees, Syllabus, Jobs, Salary`,
      specialisation: `${short} ${sub}: Course Details, Syllabus, Eligibility, Fees, Salary, Top Colleges & Career Scope`,
    },
  };
  return T[category]?.[siloKey(page)] || `${N} ${siloKey(page).replace(/([A-Z])/g, ' $1').toLowerCase()} ${y}`;
}

// Words that say nothing about which college/exam/course a doc is about.
const GENERIC = new Set(['college', 'colleges', 'university', 'institute', 'school', 'education', 'medical', 'sciences', 'science', 'technology', 'management',
  'state', 'national', 'international', 'india', 'indian', 'and', 'the', 'for', 'with', 'exam', 'test', 'course', 'bachelor', 'master', 'degree',
  'diploma', 'certificate', 'full', 'form', 'general']);
/**
 * True when the doc text names the task's entity. Names with an acronym ("[MCE]", "(DMLT)") need that acronym or the
 * full name; others need any distinctive word of the name (e.g. "Muna").
 */
function mentionsEntity(name, text) {
  const t = ` ${String(text).toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const base = String(name).split(/\s*:\s*/)[0].split(/\s*,\s*/)[0];
  const acro = base.match(/\[([^\]]+)\]/)?.[1] || base.match(/\(([A-Z][A-Za-z.&]{1,12})\)/)?.[1];
  const full = base.replace(/\s*-?\s*[[(][^\])]*[\])]\s*/g, ' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (acro) return t.includes(` ${acro.toLowerCase().replace(/[^a-z0-9]/g, '')} `) || t.includes(` ${full} `);
  const words = full.split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w));
  return !words.length || words.some((w) => t.includes(` ${w} `));
}

/**
 * Everything shown before uploading one sheet row. Nothing is changed in the CMS.
 * opts.allowOtherEntity: let a doc that never names the task's college/exam/course through (test uploads only).
 */
export async function prepare(row, opts = {}) {
  const item = { ...row, errors: [], warnings: [] };
  if (!row.taskId) item.errors.push('Task ID is empty');
  if (!row.docUrl) item.errors.push('Doc URL is empty');
  if (item.errors.length) return item;
  let found = null;
  try {
    found = await findDraft(row.taskId, row.liveUrl);
    const { task, sub, ver, notStarted, category, key } = found;
    Object.assign(item, { taskTitle: task.title, category, subTaskId: sub.subTaskId, pageUrl: sub.pageUrl, silo: category === 'blogs' ? null : siloName(sub.page) });
    if (category === 'blogs') {
      if (!row.writer) item.errors.push('Writer is empty — it is used as the author name');
      else if (GENERIC_WRITER.test(row.writer)) item.warnings.push(`Writer is "${row.writer}" — this will show as the author name on the blog`);
    }
    if (notStarted) {
      item.status = 'not started';
      item.warnings.push('Task is not started yet in the CMS — the agent will click Start (as the writer) when you upload');
    } else {
      Object.assign(item, { status: ver.version.status, number: ver.version.number });
      if (!EDITABLE.includes(ver.version.status)) item.errors.push(`Draft is "${ver.version.status}" — already with the editor, not changed`);
      item.existingChars = contentLength(ver.version, category, key);
      if (item.existingChars > HAS_CONTENT) item.warnings.push(`This draft already has content (${item.existingChars} characters) — ${category === 'blogs' ? 'uploading replaces it' : 'sections named in the doc are replaced, the others are kept'}`);
      if (category === 'blogs' && ver.version.heroImage) item.warnings.push('This draft already has a hero image — it will be replaced');
    }
  } catch (e) { item.errors.push(e.message); }

  try {
    if (!found || found.category === 'blogs') {
      const doc = await convertDoc(row.docUrl, { selfUrl: found ? selfUrlOf(found) : '', title: row.title });
      item.h1 = doc.h1 || row.title;
      item.h1Source = doc.h1 ? 'doc' : 'sheet';
      Object.assign(item, { html: doc.html, excerpt: doc.excerpt, stats: doc.stats, heroText: heroText(item.h1), autoLinks: doc.autoLinks, related: doc.related });
      item.warnings.push(...doc.warnings);
    } else {
      const silo = found.ver ? found.ver.version[found.key] : await siloTemplate(found);
      if (!silo) throw new Error('Could not read this silo\'s sections from the CMS');
      const doc = await convertSilo(row.docUrl, silo, { inOrder: found.category === 'courses', selfUrl: selfUrlOf(found) });
      const entity = found.ver?.version.entity || found.task.title;
      item.h1 = doc.h1 || siloTitle(found.ver?.version.pageDisplayTitle, found.sub, found.category, entity);
      item.h1Source = doc.h1 ? 'doc' : item.h1 === found.ver?.version.pageDisplayTitle ? 'current' : 'agent';
      Object.assign(item, { html: doc.preview, sections: doc.sections, untouched: doc.untouched, stats: doc.stats, autoLinks: doc.autoLinks });
      item.warnings.push(...doc.warnings);
      if (!doc.sections.length) item.errors.push('No section of this page was found in the doc');
      if (!mentionsEntity(entity, doc.docText)) (opts.allowOtherEntity ? item.warnings : item.errors).push(`The doc never mentions "${entity}" — it looks like it is about a different ${found.category.slice(0, -1)}. Check the Doc URL.`);
    }
  } catch (e) { item.errors.push(e.message); }
  // An H1 typed in the dashboard wins over the doc / the agent's own.
  if (String(row.h1Override || '').trim()) { item.h1 = row.h1Override.trim(); item.h1Source = 'yours'; }
  if (item.h1 !== undefined && !String(item.h1).trim()) item.errors.push('The H1 (page title) is empty');
  return item;
}

/** Submit an already-uploaded draft for review (the writer's "Submit" button). */
export async function submitDraft(taskId, liveUrl) {
  const { ver, collection, category, key } = await findDraft(taskId, liveUrl);
  if (!EDITABLE.includes(ver.version.status)) throw new Error(`Draft is "${ver.version.status}" — already with the editor`);
  if (contentLength(ver.version, category, key) <= HAS_CONTENT) throw new Error('This draft has no content yet — upload it first');
  const { createdAt, updatedAt, ...data } = ver.version;
  await savePage(collection, ver.parent, data, 'submitContentForCW');
  const { task, ver: after } = await findDraft(taskId, liveUrl);
  return { taskId, status: after.version.status, taskStatus: task.status, submitted: true };
}

/** Upload one row: content saved as the writer's draft (blogs: plus hero image, date, author); optionally submitted. */
export async function upload(row, { submit = false, allowOtherEntity = false } = {}) {
  const item = await prepare(row, { allowOtherEntity });
  if (item.errors.length) throw new Error(item.errors.join(' · '));
  const { ver, collection, category, key, sub } = await findDraft(row.taskId, row.liveUrl, { start: true });
  const { createdAt, updatedAt, ...current } = ver.version;
  let data, heroUrl = '', check;

  if (category === 'blogs') {
    const keyword = ver.version.primaryKeywords?.[0] || item.h1;
    const hero = await uploadImage({
      buffer: await makeHero(item.h1), fileName: `${keyword.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}.webp`, mimeType: 'image/webp',
      caption: keyword, altText: keyword, tags: [keyword], collectionName: collection,
    });
    heroUrl = hero.url;
    data = { ...current, title: item.h1, html: item.html, excerpt: item.excerpt, authorName: row.writer, date: todayIST(), heroImage: hero.mediaRefId };
    check = (v) => (v.html || '').length >= item.html.length * 0.9 && v.title === item.h1;
  } else {
    // Convert again on the real draft (the preview may have used the published page's layout).
    const doc = await convertSilo(row.docUrl, ver.version[key], { inOrder: category === 'courses', selfUrl: selfUrlOf({ category, sub }) });
    data = { ...current, pageDisplayTitle: String(row.h1Override || '').trim() || doc.h1 || siloTitle(current.pageDisplayTitle, sub, category, current.entity), [key]: doc.silo };
    check = (v) => doc.sections.every((s) => (v[key]?.[s.key]?.content?.html || '').length >= s.chars * 0.9);
  }
  await savePage(collection, ver.parent, data, 'saveContent');

  // Read the draft back to confirm the content really landed.
  const after = (await findDraft(row.taskId, row.liveUrl)).ver.version;
  if (!check(after)) throw new Error('The CMS accepted the save, but the draft does not show the new content — check it in the CMS');
  if (submit) await savePage(collection, ver.parent, { ...data, status: after.status }, 'submitContentForCW');
  const final = (await findDraft(row.taskId, row.liveUrl)).ver.version;
  return { row: row.row, taskId: row.taskId, h1: item.h1, status: final.status, chars: contentLength(final, category, key), heroUrl, submitted: submit, stats: item.stats, sections: item.sections };
}
