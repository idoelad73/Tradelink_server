import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.RESEND_FROM_EMAIL ?? 'TradeLink <noreply@tradelink.com>';

// @param {{ to, subject, html, attachments?: { filename, content: Buffer }[] }} options
export async function sendMail({ to, subject, html, attachments }) {
  const { error } = await resend.emails.send({ from: FROM, to, subject, html, attachments });
  if (error) throw new Error(`Resend error: ${error.message}`);
}
