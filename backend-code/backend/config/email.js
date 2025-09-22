// backend/config/email.js
'use strict';
const nodemailer = require('nodemailer');

/**
 * Prefer explicit host/port over { service: 'gmail' } so you can switch
 * providers by env without changing code.
 *
 * For Gmail:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false
 *   EMAIL_USER=your@gmail.com
 *   EMAIL_PASS=<Gmail App Password>
 */
const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.gmail.com';
const SMTP_PORT   = Number(process.env.SMTP_PORT || 587);   // 587 = STARTTLS
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true'; // true only when using port 465
const EMAIL_USER  = process.env.EMAIL_USER || '';
const EMAIL_PASS  = process.env.EMAIL_PASS || '';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
  // Helpful in containers:
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  connectionTimeout: 15000,
  socketTimeout: 20000,
});

/** Log SMTP readiness once at startup (doesn't crash app). */
(async () => {
  try {
    await transporter.verify();
    console.log(`📧 SMTP ready: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE} user=${EMAIL_USER}`);
  } catch (e) {
    console.error('❌ SMTP verify failed:', e.message);
  }
})();

async function sendVerificationEmail(to, code) {
  const from = process.env.APP_FROM || (EMAIL_USER ? `"EduConnect Official" <${EMAIL_USER}>` : 'no-reply@educonnect.local');
  const subject = 'EduConnect Verification Code';

  const text = `Dear Student,

Welcome to EduConnect! To complete your registration, please use the verification code below:

Verification Code: ${code}

If you did not request this code, you can safely ignore this email.

Warm regards,
EduConnect Team`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #333; line-height:1.5;">
      <h2 style="color:#2a7ae2; margin-bottom:10px;">Welcome to EduConnect</h2>
      <p>Dear Student,</p>
      <p>To complete your registration, please use the verification code below:</p>
      <div style="padding:12px; background:#f4f6f9; border:1px solid #d6d8db; border-radius:6px; display:inline-block; margin:12px 0;">
        <h1 style="color:#2a7ae2; letter-spacing:3px; margin:0;">${code}</h1>
      </div>
      <p>If you did not request this code, please ignore this message.</p>
      <br>
      <p style="font-size: 13px; color:#666;">Thank you,<br>EduConnect Team</p>
      <hr style="border:none; border-top:1px solid #ddd; margin:20px 0;">
      <p style="font-size: 11px; color:#999;">&copy; ${new Date().getFullYear()} EduConnect. All rights reserved.</p>
    </div>
  `;

  try {
    return await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
      },
    });
  } catch (err) {
    // Bubble up a clean error with the SMTP reason
    const reason = err?.response || err?.message || String(err);
    throw new Error(`SMTP send failed: ${reason}`);
  }
}

module.exports = { transporter, sendVerificationEmail };
