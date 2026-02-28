// src/services/mailer.service.js
let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  nodemailer = null;
}

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function buildTransport() {
  if (!nodemailer) return null;
  if (!hasSmtpConfig()) return null;

  const port = Number(process.env.SMTP_PORT);
  const secure = port === 465; // common rule-of-thumb
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendMail({ to, subject, text, html }) {
  const transport = buildTransport();

  const fromName = process.env.EMAIL_FROM_NAME || "CheckIn Support";
  const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || "no-reply@example.com";
  const from = `${fromName} <${fromEmail}>`;

  if (!transport) {
    // Dev / missing SMTP fallback — print the message so you can copy the reset link.
    console.log("\n================ EMAIL (DEV FALLBACK) ================");
    console.log("To:", to);
    console.log("Subject:", subject);
    if (text) console.log("\nTEXT:\n", text);
    if (html) console.log("\nHTML:\n", html);
    console.log("======================================================\n");
    return { ok: true, devFallback: true };
  }

  const info = await transport.sendMail({ from, to, subject, text, html });
  return { ok: true, messageId: info.messageId };
}

async function sendPasswordResetEmail({ to, name, resetUrl, ttlMinutes }) {
  const subject = "Reset your password";
  const safeName = String(name || "").trim();
  const greeting = safeName ? `Hi ${safeName},` : "Hi,";
  const text = [
    greeting,
    "",
    "We received a request to reset your password.",
    `This link will expire in ${ttlMinutes} minutes.`,
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5;">
      <p>${greeting}</p>
      <p>We received a request to reset your password.</p>
      <p><strong>This link will expire in ${ttlMinutes} minutes.</strong></p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;border-radius:10px;text-decoration:none;">
          Reset Password
        </a>
      </p>
      <p style="word-break:break-all;">If the button doesn't work, copy and paste this link:</p>
      <p style="word-break:break-all;">${resetUrl}</p>
      <p>If you did not request this, you can ignore this email.</p>
    </div>
  `;

  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendMail,
  sendPasswordResetEmail,
};
