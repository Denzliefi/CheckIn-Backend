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


function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


async function sendPasswordResetOtpEmail({ to, name = "", otp, ttlMinutes = 10 }) {
  const subject = "Your CheckIn password reset code";
  const safeName = String(name || "").trim();

  const text =
    `Hi${safeName ? " " + safeName : ""},\n\n` +
    `Your one-time code is: ${otp}\n` +
    `This code expires in ${ttlMinutes} minute(s).\n\n` +
    `If you did not request this, you can ignore this email.\n`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
      <h2 style="margin: 0 0 12px;">Password Reset Code</h2>
      <p style="margin: 0 0 12px;">
        Hi${safeName ? " <b>" + escapeHtml(safeName) + "</b>" : ""},<br/>
        Use the one-time code below to continue resetting your password:
      </p>
      <div style="display:inline-block; padding: 10px 14px; border-radius: 10px; background:#F4FFE7; border:1px solid rgba(0,0,0,.12); font-size: 20px; letter-spacing: 2px; font-weight: 800;">
        ${otp}
      </div>
      <p style="margin: 12px 0 0; font-size: 13px; color: rgba(0,0,0,.65);">
        This code expires in ${ttlMinutes} minute(s).
      </p>
      <p style="margin: 12px 0 0; font-size: 12px; color: rgba(0,0,0,.55);">
        If you did not request this, you can ignore this email.
      </p>
    </div>
  `;

  return sendMail({ to, subject, text, html });
}

async function sendLoginOtpEmail({ to, name = "", otp, ttlMinutes = 5 }) {
  const subject = "Your CheckIn login verification code";
  const safeName = String(name || "").trim();

  const text =
    `Hi${safeName ? " " + safeName : ""},

` +
    `Your one-time login code is: ${otp}
` +
    `This code expires in ${ttlMinutes} minute(s).

` +
    `If you did not try to log in, you can ignore this email.
`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
      <h2 style="margin: 0 0 12px;">Login Verification Code</h2>
      <p style="margin: 0 0 12px;">
        Hi${safeName ? " <b>" + escapeHtml(safeName) + "</b>" : ""},<br/>
        Use the one-time code below to finish logging in to CheckIn:
      </p>
      <div style="display:inline-block; padding: 10px 14px; border-radius: 10px; background:#F4FFE7; border:1px solid rgba(0,0,0,.12); font-size: 20px; letter-spacing: 2px; font-weight: 800;">
        ${otp}
      </div>
      <p style="margin: 12px 0 0; font-size: 13px; color: rgba(0,0,0,.65);">
        This code expires in ${ttlMinutes} minute(s).
      </p>
      <p style="margin: 12px 0 0; font-size: 12px; color: rgba(0,0,0,.55);">
        If you did not try to log in, you can ignore this email.
      </p>
    </div>
  `;

  return sendMail({ to, subject, text, html });
}

/**
 * Meet Request status notifications (Approved / Rescheduled / Disapproved)
 * Reusable for other email-based notifications.
 */
async function sendMeetRequestStatusEmail({
  to,
  studentName = "",
  status,
  requestId,
  date,
  time,
  sessionType,
  reason,
  meetingLink,
  location,
  counselorName,
  counselorCampus,
  studentCampus,
  rescheduledFrom,
  rescheduleNote,
  disapprovalReason,
}) {
  const safeStatus = String(status || "").trim();
  const statusLower = safeStatus.toLowerCase();

  let subject = "Counseling request update";
  if (statusLower === "approved") subject = "Your counseling request was approved";
  else if (statusLower === "rescheduled") subject = "Your counseling session was rescheduled";
  else if (statusLower === "disapproved") subject = "Your counseling request was disapproved";

  const name = String(studentName || "").trim() || "Student";
  const counselor = String(counselorName || "").trim() || "Guidance Counselor";
  const mode = String(sessionType || "").trim() || "—";

  const isOnline = String(mode).toLowerCase().includes("online");
  const isInPerson = String(mode).toLowerCase().includes("in-person") || String(mode).toLowerCase().includes("face");
  const requestLabel = isOnline ? "online meeting request" : isInPerson ? "in-person meeting request" : "counseling request";
  const resolvedMeetingLink = String(meetingLink || "").trim();
  const resolvedLocation = isInPerson ? String(location || "Guidance Counselor's office").trim() || "Guidance Counselor's office" : String(location || "").trim();
  const statusSentence =
    statusLower === "approved"
      ? `Your ${requestLabel} has been approved. Here are the details:`
      : statusLower === "rescheduled"
        ? `Your ${requestLabel} has been rescheduled. Here are the updated details:`
        : statusLower === "disapproved"
          ? `Your ${requestLabel} has been disapproved.`
          : "Your counseling request has been updated.";

  const line = (label, value) => `${label}: ${value || "—"}`;

  const lines = [
    `Hi ${name},`,
    "",
    statusSentence,
    "",
    line("Request ID", requestId ? `#${requestId}` : "—"),
    line("Schedule", [date, time].filter(Boolean).join(" • ") || "—"),
    line("Mode", mode),
  ];

  if (reason) lines.push(line("Reason", reason));

  if (statusLower === "rescheduled" && rescheduledFrom?.date && rescheduledFrom?.time) {
    const prev = [rescheduledFrom.date, rescheduledFrom.time].filter(Boolean).join(" • ");
    const prevMode = rescheduledFrom.sessionType ? ` (${rescheduledFrom.sessionType})` : "";
    lines.push("", line("Previous schedule", `${prev}${prevMode}`));
  }

  if (statusLower === "rescheduled" && rescheduleNote) lines.push(line("Counselor reason", rescheduleNote));

  if (isOnline && (statusLower === "approved" || statusLower === "rescheduled")) {
    lines.push(line("Meeting link", resolvedMeetingLink || "To be provided"));
  }

  if (isInPerson) {
    lines.push(line("Location", resolvedLocation));
  }

  if (statusLower === "disapproved") {
    lines.push("", line("Disapproval reason", disapprovalReason || "—"));
  }

  if (counselorCampus || studentCampus) {
    lines.push("", line("Campus", counselorCampus || studentCampus));
  }

  lines.push("", "Thank you,", counselor, "Guidance & Counseling Office");

  const text = lines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.55; color: #111;">
      <h2 style="margin:0 0 10px;">${escapeHtml(subject)}</h2>
      <p style="margin:0 0 12px;">Hi <b>${escapeHtml(name)}</b>,</p>
      <p style="margin:0 0 12px;">
        ${
          statusLower === "approved"
            ? `Your ${escapeHtml(requestLabel)} has been <b>approved</b>.`
            : statusLower === "rescheduled"
              ? `Your ${escapeHtml(requestLabel)} has been <b>rescheduled</b>.`
              : statusLower === "disapproved"
                ? `Your ${escapeHtml(requestLabel)} has been <b>disapproved</b>.`
                : "Your counseling request has been updated."
        }
      </p>

      <div style="border:1px solid rgba(0,0,0,.12); border-radius:14px; padding:12px 14px; background:#fff;">
        <p style="margin:0 0 6px;"><b>Request ID:</b> ${requestId ? `#${escapeHtml(requestId)}` : "—"}</p>
        <p style="margin:0 0 6px;"><b>Schedule:</b> ${escapeHtml([date, time].filter(Boolean).join(" • ") || "—")}</p>
        <p style="margin:0 0 6px;"><b>Mode:</b> ${escapeHtml(mode)}</p>
        ${reason ? `<p style="margin:0 0 6px;"><b>Reason:</b> ${escapeHtml(reason)}</p>` : ""}
        ${
          statusLower === "rescheduled" && rescheduledFrom?.date && rescheduledFrom?.time
            ? `<p style="margin:10px 0 6px;"><b>Previous schedule:</b> ${escapeHtml(
                [rescheduledFrom.date, rescheduledFrom.time].filter(Boolean).join(" • ")
              )}${rescheduledFrom.sessionType ? ` (${escapeHtml(rescheduledFrom.sessionType)})` : ""}</p>`
            : ""
        }
        ${(statusLower === "rescheduled" && rescheduleNote) ? `<p style="margin:0 0 6px;"><b>Counselor reason:</b> ${escapeHtml(rescheduleNote)}</p>` : ""}
        ${(isOnline && (statusLower === "approved" || statusLower === "rescheduled")) ? `<p style="margin:0 0 6px;"><b>Meeting link:</b> ${resolvedMeetingLink ? `<a href="${escapeHtml(resolvedMeetingLink)}">${escapeHtml(resolvedMeetingLink)}</a>` : "To be provided"}</p>` : ""}
        ${isInPerson ? `<p style="margin:0 0 6px;"><b>Location:</b> ${escapeHtml(resolvedLocation)}</p>` : ""}
        ${statusLower === "disapproved" ? `<p style="margin:10px 0 0;"><b>Disapproval reason:</b> ${escapeHtml(disapprovalReason || "—")}</p>` : ""}
      </div>

      <p style="margin:12px 0 0;">Thank you,<br/><b>${escapeHtml(counselor)}</b><br/>Guidance &amp; Counseling Office</p>
    </div>
  `;

  return sendMail({ to, subject, text, html });
}

async function sendMeetRequestDetailsUpdatedEmail(payload) {
  // Semantic wrapper so controller can call a dedicated function.
  return sendMeetRequestStatusEmail({ ...payload, status: payload?.status || "Updated" });
}


module.exports = {
  sendMail,
  sendPasswordResetEmail,
  sendPasswordResetOtpEmail,
  sendLoginOtpEmail,
  sendMeetRequestStatusEmail,
  sendMeetRequestDetailsUpdatedEmail,
};