import nodemailer from 'nodemailer';

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// @param {{ to, subject, html }} options
export async function sendMail({ to, subject, html }) {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"TradeLink" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}
