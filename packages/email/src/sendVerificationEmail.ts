// packages/email/src/sendVerificationEmail.ts
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { env } from "@bowdoin/config/env";
import { audit } from "@bowdoin/observability/audit";
import { logger } from "@bowdoin/observability/logger";
import { htmlToText } from "html-to-text";
import juice from "juice";
// NOTE: default import only; do not import named types from "mjml"
import mjml2html from "mjml";
import nodemailer, { type Transporter } from "nodemailer";

/**
 * Email provider selection:
 *  - SES: set EMAIL_PROVIDER=ses and AWS creds/region in env
 *  - SMTP: set EMAIL_PROVIDER=smtp and SMTP_* in env
 *  - LOG (default): EMAIL_PROVIDER=log -> prints the message for local/dev
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "templates");

type VerifyEmailPayload = {
  to: string;
  /** Signed token issued by API for email verification */
  token: string;
  /** Where the CTA should land (e.g., https://app.example.com/auth/verify) */
  verifyBaseUrl: string;
  /** Distinguish between Bowdoin-associated vs. community accounts for copy */
  affiliation?: string; // e.g., 'community' | 'campus' | 'staff' | 'admin'
  /** Optional: deep link back to last intent (listings/messages) */
  redirectPath?: string;
  /** Optional: explicit brand name to display; otherwise we infer. */
  brandName?: string;
};

type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  messageId: string;
};

function signLink(url: string): string {
  // Lightweight integrity suffix; server should recompute & verify.
  const secret = env.EMAIL_LINK_SIGNING_SECRET ?? "";
  const h = createHash("sha256").update(`${url}:${secret}`).digest("hex").slice(0, 16);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sig=${h}`;
}

function verificationUrl(payload: VerifyEmailPayload): string {
  const params = new URLSearchParams({
    token: payload.token,
    ...(payload.redirectPath ? { redirect: payload.redirectPath } : {}),
    ...(payload.affiliation ? { affiliation: payload.affiliation } : {}),
  });
  const raw = `${payload.verifyBaseUrl}?${params.toString()}`;
  return signLink(raw);
}

async function renderTemplate(payload: VerifyEmailPayload): Promise<RenderedEmail> {
  const mjmlPath = resolve(TEMPLATES_DIR, "community-verify.mjml");
  const mjml = await readFile(mjmlPath, "utf8");

  const ctaUrl = verificationUrl(payload);

  // Pick a friendly brand name (don’t assume APP_NAME exists)
  const brand =
    payload.brandName ??
    env.OTEL_SERVICE_NAME ??
    "Bowdoin Marketplace";

  // Very small string interpolation. If you need logic/partials, swap to React Email later.
  const rendered = mjml
    .replaceAll("{{APP_NAME}}", brand)
    .replaceAll("{{CTA_URL}}", ctaUrl)
    .replaceAll("{{RECIPIENT}}", payload.to)
    .replaceAll("{{AFFILIATION}}", payload.affiliation ?? "")
    .replaceAll("{{SUPPORT_EMAIL}}", env.EMAIL_SUPPORT_ADDRESS ?? env.EMAIL_FROM);

  const { html: mjmlHtml, errors } = mjml2html(rendered, {
    validationLevel: "strict",
    minify: true,
    keepComments: false,
  });

  if (errors.length) {
    // mjml errors contain objects; log succinctly without relying on MJML types
    logger.warn(
      {
        errors: errors.map((e: unknown) => {
          const obj = e as { line?: number; message?: string };
          return { line: obj?.line ?? null, message: obj?.message ?? "MJML error" };
        }),
      },
      "MJML validation produced warnings/errors",
    );
  }

  const inlined = juice(mjmlHtml);
  const txt = htmlToText(inlined, {
    selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
    wordwrap: 100,
  });

  const subject =
    (payload.affiliation ?? "").toLowerCase() === "community"
      ? `${brand}: Verify your community email`
      : `${brand}: Verify your email`;

  return { subject, html: inlined, text: txt, messageId: randomUUID() };
}

/** Build a nodemailer transporter for SMTP. */
function createSmtpTransport(): Transporter {
  const provider = (env.EMAIL_PROVIDER ?? "log").toLowerCase();
  if (provider !== "smtp") {
    throw new Error("createSmtpTransport called but EMAIL_PROVIDER is not smtp");
  }

  // Guard optional values; treat these as explicit booleans if present
  const secure =
    env.SMTP_SECURE === true ||
    env.SMTP_PORT === 465 ||
    String(env.SMTP_PORT ?? "") === "465";

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          }
        : undefined,
    tls:
      env.SMTP_TLS_REJECT_UNAUTHORIZED === false
        ? { rejectUnauthorized: false }
        : undefined,
  });
}

async function sendViaSes(from: string, to: string, rendered: RenderedEmail) {
  const client = new SESClient({
    // Prefer dedicated AWS_REGION; fallback to S3_REGION
    region: env.AWS_REGION ?? env.S3_REGION,
  });

  // Build raw MIME to preserve our HTML/text exactly and support future DKIM/headers.
  const boundary = `mixed-${randomUUID()}`;
  const raw = [
    "From: " + from,
    "To: " + to,
    "Subject: " + rendered.subject,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    rendered.text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    rendered.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  await client.send(
    new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(raw) },
      Source: from,
      Destinations: [to],
    }),
  );
}

async function sendViaSmtp(
  transporter: Transporter,
  from: string,
  to: string,
  rendered: RenderedEmail,
) {
  await transporter.sendMail({
    messageId: rendered.messageId,
    from,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
}

/**
 * Sends an email verification message using the configured provider.
 */
export async function sendVerificationEmail(
  payload: VerifyEmailPayload,
): Promise<{ ok: true; provider: string; messageId: string }> {
  const to = payload.to.trim().toLowerCase();
  const from = env.EMAIL_FROM;
  const provider = (env.EMAIL_PROVIDER ?? "log").toLowerCase();

  const rendered = await renderTemplate(payload);

  const meta = {
    to,
    from,
    messageId: rendered.messageId,
    provider,
    affiliation: payload.affiliation ?? undefined,
  } as const;

  logger.info(meta, "Preparing verification email");

  try {
    switch (provider) {
      case "ses":
        await sendViaSes(from, to, rendered);
        break;

      case "smtp": {
        const transporter = createSmtpTransport();
        if (env.EMAIL_VALIDATE_TRANSPORT === true) {
          await transporter.verify();
        }
        await sendViaSmtp(transporter, from, to, rendered);
        break;
      }

      case "log":
      default:
        logger.info(
          {
            ...meta,
            subject: rendered.subject,
            textPreview: rendered.text.slice(0, 140),
            verifyUrl: verificationUrl(payload),
          },
          "[DEV] Verification email (not sent)",
        );
        break;
    }

    await audit.emit("user.email_verification_sent", {
      outcome: "success",
      meta: {
        email: to,
        provider,
        affiliation: payload.affiliation ?? undefined,
        messageId: rendered.messageId,
      },
    });

    logger.info(meta, "Verification email dispatched");
    return { ok: true, provider, messageId: rendered.messageId };
  } catch (err) {
    logger.error({ err, ...meta }, "Failed to dispatch verification email");

    await audit.emit("user.email_verification_sent", {
      outcome: "failure",
      severity: "warn",
      meta: {
        email: to,
        provider,
        affiliation: payload.affiliation ?? undefined,
        messageId: rendered.messageId,
        reason: "send_failed",
      },
    });

    throw err;
  }
}

export async function renderVerificationEmailPreview(
  payload: VerifyEmailPayload,
): Promise<RenderedEmail & { to: string; from: string; url: string }> {
  const r = await renderTemplate(payload);
  const url = verificationUrl(payload);
  return { ...r, to: payload.to, from: env.EMAIL_FROM, url };
}