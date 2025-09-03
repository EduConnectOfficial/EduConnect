// ==== config/email.js ==== //
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { 
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS 
  },
});

async function sendVerificationEmail(email, code) {
  await transporter.sendMail({
    from: `"EduConnect Official" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'EduConnect Verification Code',
    text: `Dear Student,

Welcome to EduConnect! To complete your registration, please use the verification code below:

Verification Code: ${code}

If you did not request this code, you can safely ignore this email.

Warm regards,
EduConnect Team`,
    html: `
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
    `,
    headers: {
      'X-Priority': '1',
      'X-MSMail-Priority': 'High',
      'Importance': 'high',
    },
  });
}

module.exports = { transporter, sendVerificationEmail };
