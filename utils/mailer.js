import nodemailer from 'nodemailer';

// Supported providers for MVP: Gmail, Yahoo, iCloud, AOL, Zoho
// Post-MVP: migrate to Resend

// Transporter factory — swap provider via env var MAIL_PROVIDER
function createTransporter() {
  // functional code added later
  // Gmail SMTP / OAuth2 for MVP
  // Resend SMTP prep for post-MVP
}

// Send an email
// @param {{ to, subject, html, text }} options
export async function sendMail(options) {
  // functional code added later
}
