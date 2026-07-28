// Sent the moment a deposit hold is confirmed — i.e. when confirmDeposit()
// records the type:'payment' status:'deposited' message. One mail goes to the
// contractor (confirming what they just put on hold) and one to the trade pro
// (telling them the job is funded and they can start).
//
// The money is only AUTHORIZED at this point, not captured, so both bodies say
// "held" rather than "paid" — the capture happens later on work approval.

// Sizing notes for this shell:
//   • Inline styles carry the DESKTOP sizes; the media query shrinks them for
//     phones. Inline styles beat a stylesheet, so every value the query needs to
//     override is given an !important there.
//   • The card is width:100% with max-width:480px so it shrinks below 480px
//     instead of forcing a horizontal scroll on a ~360px phone screen.
//   • text-size-adjust stops iOS Mail from silently re-scaling the small type.
function depositShell({ greetingName, headline, bodyHtml, accent }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#f8fafc;padding:20px;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
@media only screen and (max-width:480px){
  body{padding:10px !important}
  .tl-card{border-radius:14px !important}
  .tl-head{padding:20px 16px !important}
  .tl-head h1{font-size:19px !important}
  .tl-head p{font-size:12px !important}
  .tl-body{padding:20px 16px !important}
  .tl-greet{font-size:13px !important}
  .tl-p{font-size:12.5px !important;margin-bottom:12px !important}
  .tl-amt{padding:13px !important}
  .tl-amt-label{font-size:10px !important}
  .tl-amt-value{font-size:23px !important}
  .tl-row-label,.tl-row-value{font-size:12px !important;padding:5px 0 !important}
}
</style>
</head><body>
<div class="tl-card" style="width:100%;max-width:480px;margin:0 auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.08)">
  <div class="tl-head" style="background:${accent};padding:26px 24px;text-align:center">
    <h1 style="color:#fff;font-size:21px;font-weight:800;letter-spacing:-.5px">TradeLink</h1>
    <p style="color:rgba(255,255,255,.85);font-size:12.5px;margin-top:4px">${headline}</p>
  </div>
  <div class="tl-body" style="padding:26px 24px">
    <p class="tl-greet" style="color:#0f172a;font-size:14px;margin-bottom:13px">Dear ${greetingName},</p>
    ${bodyHtml}
    <p class="tl-p" style="color:#475569;font-size:13px;line-height:1.6">BR<br>TradeLink.direct</p>
  </div>
</div>
</body></html>`;
}

const P = 'color:#475569;font-size:13px;line-height:1.6;margin-bottom:13px';

// Amount banner — the headline number both parties care about.
const amountBox = (amount) => `
  <div class="tl-amt" style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:14px;padding:15px;text-align:center;margin-bottom:15px">
    <p class="tl-amt-label" style="color:#047857;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Deposit Held</p>
    <p class="tl-amt-value" style="color:#065f46;font-size:26px;font-weight:800;line-height:1.2">$${Number(amount ?? 0).toFixed(2)}</p>
  </div>`;

// Key/value detail rows, skipping anything we don't have a value for.
// The value column wraps rather than overflowing — a long site address is the
// one field here that can exceed a phone's width.
const detailRows = (rows) => `
  <table class="tl-rows" style="width:100%;border-collapse:collapse;margin-bottom:15px">
    ${rows
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([label, value]) => `
      <tr>
        <td class="tl-row-label" style="padding:6px 0;color:#94a3b8;font-size:12.5px;vertical-align:top;width:40%">${label}</td>
        <td class="tl-row-value" style="padding:6px 0;color:#0f172a;font-size:12.5px;font-weight:700;text-align:right;vertical-align:top;word-break:break-word">${value}</td>
      </tr>`).join('')}
  </table>`;

// Contractor — confirmation of the hold they just authorized.
export function contractorDepositHeldEmail({ contractorName, tradeName, siteName, displayDate, amount }) {
  const subject = `💰 Deposit held for your job — ${tradeName ?? 'trade professional'}${siteName ? ` · ${siteName}` : ''}`;
  const html = depositShell({
    greetingName: contractorName ?? 'Contractor',
    headline:     'Deposit Held',
    accent:       'linear-gradient(135deg,#16a34a,#0ea5e9)',
    bodyHtml: `
      <p class="tl-p" style="${P}"><b>Deposit held for your job.</b></p>
      ${amountBox(amount)}
      ${detailRows([
        ['Trade professional', tradeName],
        ['Site / Project',     siteName],
        ['Date',               displayDate],
      ])}
      <p class="tl-p" style="${P}">The amount above is held on your card — it is <b>not charged yet</b>. It will be released to the trade professional once you approve their completed hours.</p>`,
  });
  return { subject, html };
}

// Trade pro — their job is funded, so they can start work.
export function tradeDepositHeldEmail({ tradeName, contractorName, siteName, siteAddress, displayDate, amount }) {
  const subject = `💰 Deposit held for your job${siteName ? ` — ${siteName}` : ''}`;
  const html = depositShell({
    greetingName: tradeName ?? 'there',
    headline:     'Deposit Held — You Can Start',
    accent:       'linear-gradient(135deg,#0ea5e9,#6366f1)',
    bodyHtml: `
      <p class="tl-p" style="${P}"><b>Deposit held for your job.</b></p>
      ${amountBox(amount)}
      ${detailRows([
        ['Contractor',     contractorName],
        ['Site / Project', siteName],
        ['Address',        siteAddress],
        ['Date',           displayDate],
      ])}
      <p class="tl-p" style="${P}">The contractor has secured the deposit for this job, so you're clear to start work on the date above. Log your hours in the app when you're done and the payment will be released after approval.</p>`,
  });
  return { subject, html };
}
