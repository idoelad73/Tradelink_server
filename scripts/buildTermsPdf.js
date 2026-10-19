/**
 * buildTermsPdf.js — renders the served Terms of Use PDF from the JSON.
 *
 * Why this exists: the original PDF was authored in an RTL (Hebrew) Word
 * environment, so every paragraph came out right-aligned with the bullets on
 * the wrong side, and its first page is a list of drafting to-dos for the
 * author rather than terms. That file is kept for reference at
 * docs/legal/TradeLink-Terms-of-Use-ORIGINAL.pdf; this script produces the
 * clean, left-to-right copy that users actually download.
 *
 * terms_of_use.json is the single source of truth — the modal and this PDF
 * both read it, so they cannot drift apart.
 *
 * Run:
 *   node server/scripts/buildTermsPdf.js
 */
import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync } from 'fs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dirname, '../..');
const SRC     = join(ROOT, 'client/src/constants/terms_of_use.json');
const OUT_DIR = join(ROOT, 'client/public/legal');
const OUT     = join(OUT_DIR, 'TradeLink-Terms-of-Use.pdf');

const terms = JSON.parse(readFileSync(SRC, 'utf8'));

const INK    = '#0f172a';
const SLATE  = '#334155';
const MUTED  = '#94a3b8';
const ACCENT = '#0ea5e9';
const AMBER  = '#f59e0b';

const MARGIN = 56;

mkdirSync(OUT_DIR, { recursive: true });

const doc = new PDFDocument({
  size: 'A4',
  // Required for bufferedPageRange() below — page numbers can only be stamped
  // once the total page count is known, which means holding pages in memory.
  bufferPages: true,
  margins: { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN },
  info: {
    Title:    terms.title,
    Author:   terms.operator,
    Subject:  `Terms of Use, version ${terms.version}`,
    Keywords: 'TradeLink, terms of use, marketplace',
  },
});
doc.pipe(createWriteStream(OUT));

const W = doc.page.width - MARGIN * 2;

// ── Cover header ────────────────────────────────────────────────────────────
doc.rect(0, 0, doc.page.width, 132).fill(ACCENT);
doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26)
   .text('TradeLink', MARGIN, 40, { width: W, align: 'left' });
doc.font('Helvetica').fontSize(14).fillColor('#e0f2fe')
   .text('Terms of Use', MARGIN, 74, { width: W, align: 'left' });
doc.font('Helvetica').fontSize(9).fillColor('#e0f2fe')
   .text(`Effective ${terms.effectiveDate}   ·   Version ${terms.version}`, MARGIN, 98, { width: W, align: 'left' });

doc.y = 160;

doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
   .text('Operator: ', { continued: true })
   .font('Helvetica').fillColor(SLATE)
   .text(terms.operator);
doc.moveDown(0.4);
doc.font('Helvetica').fontSize(9).fillColor(MUTED)
   .text(`${terms.contact.entity} · ${terms.contact.address}`, { width: W });
doc.font('Helvetica').fontSize(9).fillColor(MUTED)
   .text(terms.contact.email, { width: W });

doc.moveDown(1);
doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + W, doc.y).strokeColor('#e2e8f0').lineWidth(1).stroke();
doc.moveDown(1);

// ── Sections ────────────────────────────────────────────────────────────────
// A heading stranded at the foot of a page reads badly, so push it to the next
// one when there isn't room for the heading plus a line or two beneath it.
function ensureRoom(points) {
  if (doc.y + points > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

for (const section of terms.sections) {
  ensureRoom(70);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(ACCENT)
     .text(`${section.number}. ${section.title}`, { width: W });
  doc.moveDown(0.35);

  for (const clause of section.clauses) {
    ensureRoom(44);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
       .text(`${clause.id} ${clause.heading}. `, { width: W, continued: true, align: 'left' })
       .font('Helvetica').fillColor(SLATE)
       .text(clause.text, { width: W, align: 'left', lineGap: 1.5 });

    if (clause.list) {
      doc.moveDown(0.25);
      for (const item of clause.list) {
        ensureRoom(26);
        const x = MARGIN + 14;
        const y = doc.y;
        doc.circle(x + 2, y + 5, 1.6).fill(AMBER);
        doc.font('Helvetica').fontSize(9.5).fillColor(SLATE)
           .text(item, x + 12, y, { width: W - 26, align: 'left', lineGap: 1 });
      }
    }
    doc.moveDown(0.55);
  }
}

// ── Footer: page numbers on every page ──────────────────────────────────────
const range = doc.bufferedPageRange();
const pages = range.count;
for (let i = 0; i < pages; i++) {
  doc.switchToPage(range.start + i);
  // The footer sits BELOW the bottom margin. PDFKit treats writing past the
  // margin as overflow and silently starts a new page — which produced a blank
  // footer-only page per stamp. Dropping the margin for the stamp prevents it.
  const restore = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const bottom = doc.page.height - 42;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
     .text(`${terms.title} · v${terms.version}`, MARGIN, bottom, { width: W / 2, align: 'left', lineBreak: false })
     .text(`Page ${i + 1} of ${pages}`, MARGIN + W / 2, bottom, { width: W / 2, align: 'right', lineBreak: false });

  doc.page.margins.bottom = restore;
}

doc.end();
console.log(`✅ wrote ${OUT}`);
