import sharp from 'sharp';
import { readFileSync } from 'node:fs';

// Branded hero image (1280×720 WebP), styled like the SYU blog heroes:
// navy title, pink highlight banner, year pill, SYU logo, light background and a small checklist card.
const W = 1280, H = 720;
const NAVY = '#1d1f5e', PINK = '#e5206e';
const FONT = "'Arial Black', 'Segoe UI Black', 'Segoe UI', Arial, sans-serif";
const LOGO = readFileSync(new URL('../public/logo.png', import.meta.url));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textW = (s, size) => s.length * size * 0.66; // rough width of Arial Black text

/** Short hero text from the H1: the part before ":", " - " or "|" (e.g. "NEET PG 2025 Seat Matrix Revised"). */
export function heroText(h1) {
  const short = String(h1).split(/\s*[:|–—]\s*|\s+-\s*|-\s+/)[0].trim();
  return short.length >= 12 ? short : String(h1).trim();
}

/** Split into the hero layout: navy line, pink banner line, optional year pill, navy line(s). */
function layout(text) {
  const year = text.match(/\b(19|20)\d{2}\b/)?.[0] || '';
  const words = text.replace(year, ' ').split(/\s+/).filter(Boolean);
  const lines = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 15) lines[lines.length - 1] = last + ' ' + w; else lines.push(w);
  }
  while (lines.length > 4) { const l = lines.pop(); lines[lines.length - 1] += ' ' + l; }
  return { year, lines };
}

export async function makeHero(h1, cardItems = ['Latest Update', 'Key Dates', 'Next Steps']) {
  const { year, lines } = layout(heroText(h1));
  const longest = Math.max(...lines.map((l) => l.length), 6);
  const size = Math.max(52, Math.min(86, Math.floor(760 / (longest * 0.66))));
  const cx = 470; // title column centre (left of the checklist card)

  // Rows: line 0 navy, line 1 on the pink banner, year pill, then the rest navy.
  const rows = lines.map((l, i) => ({ text: l, kind: i === 1 || (lines.length === 1 && i === 0 && !year) ? 'banner' : 'navy' }));
  if (year) rows.splice(Math.min(2, rows.length), 0, { text: year, kind: 'pill' });
  const rowH = (r) => (r.kind === 'navy' ? size * 1.12 : size * 1.3);
  const total = rows.reduce((n, r) => n + rowH(r) + 14, 0);
  let y = Math.max(150, (H - total) / 2 + 30);

  let title = '';
  for (const r of rows) {
    const h = rowH(r);
    if (r.kind === 'navy') {
      title += `<text x="${cx}" y="${y + size * 0.86}" font-size="${size}" fill="${NAVY}" text-anchor="middle" font-family="${FONT}" font-weight="900">${esc(r.text)}</text>`;
    } else if (r.kind === 'banner') {
      const bw = textW(r.text, size * 0.92) + 70;
      title += `<g transform="rotate(-2 ${cx} ${y + h / 2})"><rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${h}" rx="14" fill="${PINK}"/>
        <text x="${cx}" y="${y + h * 0.74}" font-size="${size * 0.92}" fill="#fff" text-anchor="middle" font-family="${FONT}" font-weight="900">${esc(r.text)}</text></g>`;
    } else {
      const pw = textW(r.text, size * 0.86) + 90;
      title += `<rect x="${cx - pw / 2}" y="${y}" width="${pw}" height="${h}" rx="${h / 2}" fill="${NAVY}"/>
        <path d="M${cx - pw / 2 - 46} ${y + h / 2 - 18} l26 8 M${cx - pw / 2 - 50} ${y + h / 2} l28 0 M${cx - pw / 2 - 46} ${y + h / 2 + 18} l26 -8 M${cx + pw / 2 + 20} ${y + h / 2 - 10} l26 -8 M${cx + pw / 2 + 22} ${y + h / 2 + 8} l28 0 M${cx + pw / 2 + 20} ${y + h / 2 + 26} l26 8" stroke="${PINK}" stroke-width="6" stroke-linecap="round"/>
        <text x="${cx}" y="${y + h * 0.75}" font-size="${size * 0.86}" fill="#fff" text-anchor="middle" font-family="${FONT}" font-weight="900">${esc(r.text)}</text>`;
    }
    y += h + 14;
  }

  // Checklist card on the right (like the calendar card in the SYU heroes).
  const card = `<g transform="rotate(4 1085 470)">
    <rect x="955" y="300" width="260" height="300" rx="18" fill="#fff" stroke="#d9def0" stroke-width="2" filter="url(#sh)"/>
    <rect x="955" y="300" width="260" height="46" rx="18" fill="${NAVY}"/><rect x="955" y="328" width="260" height="18" fill="${NAVY}"/>
    ${[0, 1, 2, 3, 4, 5].map((k) => `<circle cx="${985 + k * 40}" cy="300" r="7" fill="#fff" stroke="${NAVY}" stroke-width="3"/>`).join('')}
    ${cardItems.slice(0, 3).map((t, k) => `<g transform="translate(980 ${385 + k * 70})"><rect width="30" height="30" rx="6" fill="none" stroke="${NAVY}" stroke-width="3"/>
      <path d="M6 15 l7 7 l12 -14" stroke="${PINK}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="44" y="23" font-size="22" fill="${NAVY}" font-family="'Segoe UI', Arial, sans-serif" font-weight="700">${esc(t)}</text></g>`).join('')}
  </g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef3ff"/><stop offset="0.55" stop-color="#ffffff"/><stop offset="1" stop-color="#fdeef5"/></linearGradient>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#1d1f5e" flood-opacity="0.18"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <circle cx="80" cy="640" r="260" fill="${PINK}" opacity="0.07"/><circle cx="1180" cy="90" r="220" fill="${NAVY}" opacity="0.06"/>
    <circle cx="300" cy="80" r="90" fill="${PINK}" opacity="0.05"/>
    <path d="M0 ${H - 26} H${W}" stroke="${PINK}" stroke-width="10"/>
    <rect x="1000" y="34" width="250" height="84" rx="42" fill="#fff" filter="url(#sh)"/>
    ${title}${card}
    <text x="40" y="${H - 46}" font-size="22" fill="${NAVY}" opacity="0.7" font-family="'Segoe UI', Arial, sans-serif" font-weight="600">selectyouruniversity.com</text>
  </svg>`;

  const logo = await sharp(LOGO).resize({ height: 66 }).toBuffer();
  return sharp(Buffer.from(svg))
    .composite([{ input: logo, left: 1022, top: 43 }])
    .webp({ quality: 86 })
    .toBuffer();
}
