// Sent the moment a deposit hold is confirmed — i.e. when confirmDeposit()
// records the type:'payment' status:'deposited' message. One mail goes to the
// contractor (confirming what they just put on hold) and one to the trade pro
// (telling them the job is funded and they can start).
//
// The money is only AUTHORIZED at this point, not captured, so both bodies say
// "held" rather than "paid" — the capture happens later on work approval.

function depositShell({ greetingName, headline, bodyHtml, accent }) {
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

// Amount banner — the headline number both parties care about.
const amountBox = (amount) => `
  <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:14px;padding:16px;text-align:center;margin-bottom:16px">
    <p style="color:#047857;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">Deposit Held</p>
    <p style="color:#065f46;font-size:28px;font-weight:800">$${Number(amount ?? 0).toFixed(2)}</p>
  </div>`;

// Key/value detail rows, skipping anything we don't have a value for.
const detailRows = (rows) => `
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    ${rows
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([label, value]) => `
      <tr>
        <td style="padding:7px 0;color:#94a3b8;font-size:13px;vertical-align:top;width:42%">${label}</td>
        <td style="padding:7px 0;color:#0f172a;font-size:13px;font-weight:700;text-align:right">${value}</td>
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
      <p style="${P}"><b>Deposit held for your job.</b></p>
      ${amountBox(amount)}
      ${detailRows([
        ['Trade professional', tradeName],
        ['Site / Project',     siteName],
        ['Date',               displayDate],
      ])}
      <p style="${P}">The amount above is held on your card — it is <b>not charged yet</b>. It will be released to the trade professional once you approve their completed hours.</p>`,
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
      <p style="${P}"><b>Deposit held for your job.</b></p>
      ${amountBox(amount)}
      ${detailRows([
        ['Contractor',     contractorName],
        ['Site / Project', siteName],
        ['Address',        siteAddress],
        ['Date',           displayDate],
      ])}
      <p style="${P}">The contractor has secured the deposit for this job, so you're clear to start work on the date above. Log your hours in the app when you're done and the payment will be released after approval.</p>`,
  });
  return { subject, html };
}
