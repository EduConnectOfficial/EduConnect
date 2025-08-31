// ==== config/email.js ==== //
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

async function sendVerificationEmail(email, code) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your DigiPic Verification Code',
    text: `Your DigiPic verification code is: ${code}`,
  });
}

module.exports = { transporter, sendVerificationEmail };
