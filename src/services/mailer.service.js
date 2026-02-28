// src/services/mailer.service.js
/**
 * Mailer transport strategy (Render Free friendly):
 * - Prefer HTTPS Email API (Brevo) if BREVO_API_KEY is set (works on Render Free).
 * - Otherwise fall back to SMTP via Nodemailer (good for localhost/dev).
 * - If neither is configured, log the email to console (dev fallback).
 */

let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  nodemailer = null;
}

function hasBrevoConfig() {
  return Boolean(process.env.BREVO_API_KEY && String(process.env.BREVO_API_KEY).trim());
}

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function normalizeSmtpPass(pass) {
  // Gmail app passwords are often shown with spaces. Nodemailer expects the raw 16 chars.
  return String(pass || "").replace(/\s+/g, "");
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
      pass: normalizeSmtpPass(process.env.SMTP_PASS),
    },
  });
}

function getFrom() {
  const fromName = process.env.EMAIL_FROM_NAME || "CheckIn Support";
  const fromEmail = process.env.EMAIL_FROM || process.env.SMTP_USER || "no-reply@example.com";
  return { fromName, fromEmail, from: `${fromName} <${fromEmail}>` };
}

function normalizeTo(to) {
  if (Array.isArray(to)) return to.filter(Boolean).map(String);
  return [String(to || "").trim()].filter(Boolean);
}

async function sendViaBrevo({ to, subject, text, html }) {
  const { fromName, fromEmail } = getFrom();
  const toList = normalizeTo(to).map((email) => ({ email }));

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: toList,
    subject,
    // Brevo accepts either (or both)
    textContent: text || undefined,
    htmlContent: html || undefined,
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": String(process.env.BREVO_API_KEY).trim(),
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    const msg = data ? JSON.stringify(data) : (await res.text().catch(() => ""));
    const err = new Error(`BREVO_SEND_FAILED (${res.status}): ${msg || "Unknown error"}`);
    err.provider = "brevo";
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return { ok: true, provider: "brevo", messageId: data?.messageId };
}

async function sendViaSmtp({ to, subject, text, html }) {
  const transport = buildTransport();
  const { from } = getFrom();

  if (!transport) {
    return null; // caller decides fallback
  }

  const info = await transport.sendMail({ from, to, subject, text, html });
  return { ok: true, provider: "smtp", messageId: info.messageId };
}

async function sendMail({ to, subject, text, html }) {
  // 1) Prefer Brevo API if configured (works on Render Free)
  if (hasBrevoConfig()) {
    return sendViaBrevo({ to, subject, text, html });
  }

  // 2) Try SMTP (useful on localhost/dev)
  const smtpRes = await sendViaSmtp({ to, subject, text, html });
  if (smtpRes) return smtpRes;

  // 3) Dev / missing configs fallback — print the message so you can copy the reset link.
  console.log("\n================ EMAIL (DEV FALLBACK) ================");
  console.log("To:", to);
  console.log("Subject:", subject);
  if (text) console.log("\nTEXT:\n", text);
  if (html) console.log("\nHTML:\n", html);
  console.log("======================================================\n");
  return { ok: true, devFallback: true };
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
