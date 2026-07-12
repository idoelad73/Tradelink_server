// Receipt PDF — the full itemized breakdown, generated server-side and attached
// to the (now minimal) receipt email. Shared shell used by both the contractor's
// and the trade pro's PDF so the design only needs to change in one place.

import PDFDocument from 'pdfkit';

const GREEN = '#16a34a';
const SKY   = '#0ea5e9';
const INK   = '#0f172a';
const SLATE = '#475569';
const MUTED = '#94a3b8';
const LINE  = '#e2e8f0';
const CARD_BG = '#f0fdf4';
const CARD_BORDER = '#86efac';

function renderReceiptPdf({ receiptNumber, greetingName, firstRowLabel, firstRowValue,
  siteName, displayDate, actualHours, workersNo, hourlyRate, orderSum, feePercent,
  feeSign, feeDollars, totalLabel, totalAmount }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const cardX = 56;
    const cardW = pageW - cardX * 2;

    // ── Header banner ──────────────────────────────────────────────────────
    doc.rect(0, 0, pageW, 130)
      .fill()
      .save()
      .clip();
    const grad = doc.linearGradient(0, 0, pageW, 130);
    grad.stop(0, GREEN).stop(1, SKY);
    doc.rect(0, 0, pageW, 130).fill(grad);
    doc.restore();

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26).text('TradeLink', cardX, 42);
    doc.font('Helvetica').fontSize(12).fillColor('rgba(255,255,255,0.85)')
      .fillColor('#eafff5').text('Payment Receipt', cardX, 74);

    if (receiptNumber) {
      doc.font('Helvetica').fontSize(9).fillColor('#eafff5')
        .text('RECEIPT NO.', 0, 44, { align: 'right', width: pageW - cardX });
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
        .text(receiptNumber, 0, 58, { align: 'right', width: pageW - cardX });
    }

    // ── Greeting ────────────────────────────────────────────────────────────
    let y = 165;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(`Hi ${greetingName},`, cardX, y);
    y += 22;
    doc.fillColor(SLATE).font('Helvetica').fontSize(10.5)
      .text('Your payment has been processed successfully. Here is the full breakdown of this receipt.', cardX, y, { width: cardW, lineGap: 3 });
    y += 40;

    // ── Order summary card ─────────────────────────────────────────────────
    const rows = [
      [firstRowLabel, firstRowValue],
      ['Site', siteName],
      ['Date', displayDate],
      ['Hours', `${actualHours}h`],
      ['Workers', String(workersNo)],
      ['Rate', `$${hourlyRate}/hr`],
    ];
    const rowH = 24;
    const cardTitleH = 30;
    const totalRowH = 30;
    const feeRowH = 22;
    const cardH = cardTitleH + rows.length * rowH + totalRowH + feeRowH + 16;

    doc.roundedRect(cardX, y, cardW, cardH, 12).fillAndStroke(CARD_BG, CARD_BORDER);

    let ry = y + 16;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#166534')
      .text('ORDER SUMMARY', cardX + 20, ry, { characterSpacing: 0.5 });
    ry += cardTitleH;

    rows.forEach(([label, value]) => {
      doc.font('Helvetica').fontSize(10.5).fillColor(SLATE).text(label, cardX + 20, ry);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
        .text(String(value), cardX + 20, ry, { width: cardW - 40, align: 'right' });
      ry += rowH;
    });

    // Divider before order total
    doc.moveTo(cardX + 20, ry).lineTo(cardX + cardW - 20, ry).strokeColor(CARD_BORDER).lineWidth(1).stroke();
    ry += 8;
    doc.font('Helvetica').fontSize(10.5).fillColor(SLATE).text('Order Total', cardX + 20, ry);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
      .text(`$${orderSum}`, cardX + 20, ry, { width: cardW - 40, align: 'right' });
    ry += totalRowH;

    doc.font('Helvetica').fontSize(10).fillColor(SLATE)
      .text(`Platform Fee (${feePercent}%)`, cardX + 20, ry);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(`${feeSign}$${feeDollars}`, cardX + 20, ry, { width: cardW - 40, align: 'right' });

    y += cardH + 24;

    // ── Total box ───────────────────────────────────────────────────────────
    const totalBoxH = 70;
    doc.roundedRect(cardX, y, cardW, totalBoxH, 12).fillAndStroke('#ecfdf5', '#34d399');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#065f46')
      .text(totalLabel.toUpperCase(), cardX, y + 16, { width: cardW, align: 'center', characterSpacing: 0.4 });
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#065f46')
      .text(`$${totalAmount}`, cardX, y + 32, { width: cardW, align: 'center' });

    y += totalBoxH + 30;

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('Thank you for using TradeLink. Please keep this document as your payment record.', cardX, y, { width: cardW, align: 'center', lineGap: 2 });

    doc.moveTo(cardX, y + 40).lineTo(cardX + cardW, y + 40).strokeColor(LINE).lineWidth(1).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text('TradeLink · Connecting trade professionals with projects', cardX, y + 52, { width: cardW, align: 'center' });

    doc.end();
  });
}

// PDF sent to the contractor — shows the full order total charged.
export function contractorReceiptPdf({ receiptNumber, contractorName, tradeName, siteName,
  displayDate, actualHours, workersNo, hourlyRate, orderSum, feePercent, feeDollars }) {
  return renderReceiptPdf({
    receiptNumber,
    greetingName:  contractorName ?? 'Contractor',
    firstRowLabel: 'Trade Pro',
    firstRowValue: tradeName,
    siteName, displayDate, actualHours, workersNo, hourlyRate, orderSum, feePercent, feeDollars,
    feeSign:     '',
    totalLabel:  'Total Charged',
    totalAmount: orderSum,
  });
}

// PDF sent to the trade pro — shows their payout after the platform fee.
export function tradeReceiptPdf({ receiptNumber, tradeName, contractorName, siteName,
  displayDate, actualHours, workersNo, hourlyRate, orderSum, feePercent, feeDollars, payoutAmount }) {
  return renderReceiptPdf({
    receiptNumber,
    greetingName:  tradeName,
    firstRowLabel: 'Contractor',
    firstRowValue: contractorName ?? '—',
    siteName, displayDate, actualHours, workersNo, hourlyRate, orderSum, feePercent, feeDollars,
    feeSign:     '-',
    totalLabel:  'Total Paid to You',
    totalAmount: payoutAmount,
  });
}
