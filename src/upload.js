import { cmsGet, qs, savePage, uploadImage } from './cms.js';
import { convertDoc } from './doc.js';
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
const HAS_CONTENT = 200; // html longer than this = the draft already has content

/** Today at midnight India time, as the CMS date picker stores it (e.g. 2026-10-26T18:30:00.000Z for 27 Oct). */
function todayIST() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return new Date(`${d}T00:00:00+05:30`).toISOString();
}

/**
 * CMS task → its blog subtask → the writer's draft version.
 * A task the writer has not started yet has no draft: with start = true the agent clicks "Start" (as the writer
 * would), which makes the CMS create the draft; otherwise ver is null and notStarted is true.
 */
async function findDraft(taskId, { start = false } = {}) {
  const task = (await cmsGet(`/tasks?${qs({ 'where[taskId][equals]': taskId, limit: 1, depth: 0 })}`)).docs[0];
  if (!task) throw new Error(`Task ${taskId} not found in the CMS`);
  const where = PAGES[task.contentCategory];
  if (!where) throw new Error(`Task ${taskId} is a "${task.contentCategory}" task — not supported`);
  if (task.contentCategory !== 'blogs') throw new Error(`Task ${taskId} is a ${task.contentCategory.slice(0, -1)} silo task — silo upload is not built yet (blogs only for now)`);
  const subs = (await cmsGet(`/subTasks?${qs({ 'where[parentTaskId][equals]': task.id, limit: 20, depth: 0 })}`)).docs;
  const sub = subs.find((s) => s.page === 'blogContent') || subs[0];
  if (!sub) throw new Error(`Task ${taskId} has no subtask`);
  const draft = async () => (await cmsGet(`/${where.versions}?${qs({ 'where[version.subTaskRef][equals]': sub.id, sort: '-updatedAt', limit: 1, depth: 0 })}`)).docs[0];
  let ver = await draft();
  if (!ver && sub.status === 'open') {
    if (!start) return { task, sub, ver: null, notStarted: true, collection: where.collection };
    const { createdAt, updatedAt, ...fields } = sub;
    await savePage('subTasks', sub.id, fields, 'startTaskForCW');
    ver = await draft();
  }
  if (!ver) throw new Error(`Subtask ${sub.subTaskId} (${sub.status}) has no draft — open it in the CMS as the writer and click Start`);
  return { task, sub, ver, collection: where.collection };
}

const GENERIC_WRITER = /^content\s*writer$/i;

/** Everything shown before uploading one sheet row. Nothing is changed in the CMS. */
export async function prepare(row) {
  const item = { ...row, errors: [], warnings: [] };
  if (!row.taskId) item.errors.push('Task ID is empty');
  if (!row.docUrl) item.errors.push('Doc URL is empty');
  if (!row.writer) item.errors.push('Writer is empty — it is used as the author name');
  else if (GENERIC_WRITER.test(row.writer)) item.warnings.push(`Writer is "${row.writer}" — this will show as the author name on the blog`);
  if (item.errors.length) return item;
  try {
    const { task, sub, ver, notStarted } = await findDraft(row.taskId);
    Object.assign(item, { taskTitle: task.title, category: task.contentCategory, subTaskId: sub.subTaskId, pageUrl: sub.pageUrl });
    if (notStarted) {
      item.status = 'not started';
      item.warnings.push('Task is not started yet in the CMS — the agent will click Start (as the writer) when you upload');
      return withDoc(item, row);
    }
    Object.assign(item, { status: ver.version.status, number: ver.version.number });
    if (!EDITABLE.includes(ver.version.status)) item.errors.push(`Draft is "${ver.version.status}" — already with the editor, not changed`);
    item.existingChars = (ver.version.html || '').length;
    if (item.existingChars > HAS_CONTENT) item.warnings.push(`This draft already has content (${item.existingChars} characters) — uploading replaces it`);
    if (ver.version.heroImage) item.warnings.push('This draft already has a hero image — it will be replaced');
  } catch (e) { item.errors.push(e.message); }
  return withDoc(item, row);
}

/** Add the converted Google Doc (H1, html, excerpt, stats) to a preview item. */
async function withDoc(item, row) {
  try {
    const doc = await convertDoc(row.docUrl);
    item.h1 = doc.h1 || row.title;
    Object.assign(item, { html: doc.html, excerpt: doc.excerpt, stats: doc.stats, heroText: heroText(item.h1) });
    item.warnings.push(...doc.warnings);
  } catch (e) { item.errors.push(e.message); }
  return item;
}

/** Submit an already-uploaded draft for review (the writer's "Submit" button). */
export async function submitDraft(taskId) {
  const { ver, collection } = await findDraft(taskId);
  if (!EDITABLE.includes(ver.version.status)) throw new Error(`Draft is "${ver.version.status}" — already with the editor`);
  if ((ver.version.html || '').length <= HAS_CONTENT) throw new Error('This draft has no content yet — upload it first');
  const { createdAt, updatedAt, ...data } = ver.version;
  await savePage(collection, ver.parent, data, 'submitContentForCW');
  const { task, ver: after } = await findDraft(taskId);
  return { taskId, status: after.version.status, taskStatus: task.status, submitted: true };
}

/** Upload one row: hero image, then content saved as the writer's draft; optionally submitted for review. */
export async function upload(row, { submit = false } = {}) {
  const item = await prepare(row);
  if (item.errors.length) throw new Error(item.errors.join(' · '));
  const { ver, collection } = await findDraft(row.taskId, { start: true });

  const keyword = ver.version.primaryKeywords?.[0] || item.h1;
  const hero = await uploadImage({
    buffer: await makeHero(item.h1), fileName: `${keyword.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}.webp`, mimeType: 'image/webp',
    caption: keyword, altText: keyword, tags: [keyword], collectionName: collection,
  });

  const { createdAt, updatedAt, ...current } = ver.version;
  const data = { ...current, title: item.h1, html: item.html, excerpt: item.excerpt, authorName: row.writer, date: todayIST(), heroImage: hero.mediaRefId };
  await savePage(collection, ver.parent, data, 'saveContent');

  // Read the draft back to confirm the content really landed.
  const after = (await findDraft(row.taskId)).ver.version;
  if ((after.html || '').length < item.html.length * 0.9 || after.title !== item.h1) throw new Error('The CMS accepted the save, but the draft does not show the new content — check it in the CMS');
  if (submit) await savePage(collection, ver.parent, { ...data, status: after.status }, 'submitContentForCW');
  const final = (await findDraft(row.taskId)).ver.version;
  return { row: row.row, taskId: row.taskId, h1: item.h1, status: final.status, chars: (final.html || '').length, heroUrl: hero.url, submitted: submit, stats: item.stats };
}
