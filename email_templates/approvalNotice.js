// Sent when a work log is APPROVED but the payout has not settled yet.
//
// Deliberately not a receipt: no receipt number is allocated and no PDF is
// attached, because no money has moved. Issuing a numbered receipt here would
// burn a sequential ledger entry on a non-payment and produce a second receipt
// for the same job once the payout actually clears.

function noticeShell({ greetingName, headline, bodyHtml, accent }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px}</style>
</head><body>
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div style="background:${accent};padding:28px;text-align:center">
    <h1 style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">${headline}</p>
  </div>
  <div style="padding:32px">
    <p style="color:#0f172a;font-size:15px;margin-bottom:14px">Dear ${greetingName},</p>
    ${bodyHtml}
    <p style="color:#475569;font-size:14px;">BR<br>TradeLink.direct</p>
  </div>
</div>
</body></html>`;
}

const P = 'color:#475569;font-size:14px;line-height:1.6;margin-bottom:14px';

// Contractor — their approval went through; the payout to the trade pro hasn't.
export function contractorApprovalPendingEmail({ contractorName, tradeName, siteName, displayDate, orderSum, reasonMessage }) {
  const subject = `✅ Work Approved — payout pending — ${tradeName} · ${siteName}`;
  const html = noticeShell({
    greetingName: contractorName ?? 'Contractor',
    headline:     'Work Approved — Payout Pending',
    accent:       'linear-gradient(135deg,#f59e0b,#0ea5e9)',
    bodyHtml: `
      <p style="${P}">You approved <b>${tradeName}</b>'s work at <b>${siteName}</b>${displayDate ? ` on ${displayDate}` : ''}, totalling <b>$${Number(orderSum).toFixed(2)}</b>.</p>
      <p style="${P}">The payout to them has <b>not completed yet</b>${reasonMessage ? `: ${reasonMessage}` : '.'}</p>
      <p style="${P}">No receipt is issued until the payment settles. You'll receive your receipt automatically once it does — no action needed from you.</p>`,
  });
  return { subject, html };
}

// Trade pro — work approved, but we could not pay them. This is the actionable one.
export function tradePayoutBlockedEmail({ tradeName, siteName, displayDate, payoutAmount, reasonMessage }) {
  const subject = `⚠️ Action needed — check your bank account — ${siteName}`;
  const html = noticeShell({
    greetingName: tradeName ?? 'there',
    headline:     'Payout Could Not Be Sent',
    accent:       'linear-gradient(135deg,#ef4444,#f59e0b)',
    bodyHtml: `
      <p style="${P}">Good news first — your work at <b>${siteName}</b>${displayDate ? ` on ${displayDate}` : ''} was <b>approved</b>.</p>
      <p style="${P}">However, we could not send your payout of <b>$${Number(payoutAmount).toFixed(2)}</b>.</p>
      <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:12px 14px;color:#b91c1c;font-size:13px;line-height:1.6;margin-bottom:14px"><b>Please check your bank account:</b><br>${reasonMessage}</p>
      <p style="${P}">Your payment is safe and still owed to you. Once your bank details are verified, the payout will be released and your receipt issued automatically.</p>`,
  });
  return { subject, html };
}
