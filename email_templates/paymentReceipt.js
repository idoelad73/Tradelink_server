// Payment-receipt email bodies — kept intentionally minimal. The full itemized
// breakdown lives in the attached PDF (see email_templates/receiptPdf.js);
// the email itself is just a short notice pointing to that attachment.

// When the PDF could not be generated the email still goes out — losing the
// notice as well would leave the recipient with no record of a payment that
// actually happened. It says so plainly and quotes the receipt number so they
// have the identifier to chase.
function attachmentLine({ pdfAttached, receiptNumber }) {
  if (pdfAttached) {
    return `<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:24px">📎 The full receipt is attached to this email as a PDF.</p>`;
  }
  return `<p style="color:#b45309;font-size:13px;line-height:1.6;margin-bottom:24px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px">
      We could not attach the PDF copy of this receipt. Your receipt number is
      <b>${receiptNumber ?? '—'}</b> — please contact support quoting it and we will send the PDF.
    </p>`;
}

function receiptShell({ greetingName, pdfAttached = true, receiptNumber }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#22c55e,#0ea5e9);padding:28px;text-align:center">
    <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">Payment Receipt</p>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:14px">Dear ${greetingName},</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin-bottom:14px">Your payment has been processed successfully. Here is your receipt.</p>
    ${attachmentLine({ pdfAttached, receiptNumber })}
    <p style="color:#475569;font-size:14px;">BR<br>TradeLink.direct</p>
  </div>
</div>
</body></html>`;
}

// Sent to the contractor.
export function contractorReceiptEmail({ contractorName, tradeName, siteName, pdfAttached, receiptNumber }) {
  const subject = `🧾 Payment Receipt — ${tradeName} · ${siteName} — TradeLink`;
  const html = receiptShell({ greetingName: contractorName ?? 'Contractor', pdfAttached, receiptNumber });
  return { subject, html };
}

// Sent to the trade pro.
export function tradeReceiptEmail({ tradeName, siteName, pdfAttached, receiptNumber }) {
  const subject = `🧾 Payment Receipt — ${siteName} — TradeLink`;
  const html = receiptShell({ greetingName: tradeName, pdfAttached, receiptNumber });
  return { subject, html };
}
