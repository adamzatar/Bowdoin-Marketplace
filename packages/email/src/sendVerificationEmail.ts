// packages/email/src/sendVerificationEmail.ts
/**
 * Server-only email utilities.
 * Heavy deps (mjml / juice / html-to-text / nodemailer / AWS SDK) are lazy-loaded only when needed.
 */

const __isServer = typeof window === 'undefined';
if (!__isServer) {
  throw new Error('packages/email: sendVerificationEmail must only be imported on the server.');
}

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '@bowdoin/config/env';
import { audit } from '@bowdoin/observability/audit';
import { logger } from '@bowdoin/observability/logger';

// Type-only (runtime deps are lazy)
import type { Transporter } from 'nodemailer';
import type { SESClientConfig } from '@aws-sdk/client-ses';

const INLINE_FALLBACK_MJML = `
<mjml>
  <mj-head>
    <mj-title>{{APP_NAME}} – Verify your email</mj-title>
  </mj-head>
  <mj-body background-color="#f7f7fb">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="600">Verify your email</mj-text>
        <mj-text>Hello {{RECIPIENT}},</mj-text>
        <mj-text>Please confirm your email to continue{{#AFFILIATION}} ({{AFFILIATION}}){{/AFFILIATION}}.</mj-text>
        <mj-button href="{{CTA_URL}}" background-color="#1f70ff">Verify email</mj-button>
        <mj-text>If the button doesn't work, copy this link into your browser:</mj-text>
        <mj-text>{{CTA_URL}}</mj-text>
        <mj-text font-size="12px" color="#777">
          Need help? Contact {{SUPPORT_EMAIL}}.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`.trim();

async function loadCommunityTemplate(): Promise<string> {
  const moduleUrl =
    typeof import.meta !== 'undefined' && import.meta.url
      ? import.meta.url
      : typeof __filename === 'string'
        ? `file://${__filename}`
        : `file://${process.cwd()}/`;
  const here = dirname(fileURLToPath(moduleUrl));
  const compiledPath = join(here, 'templates', 'community-verify.mjml');

  try {
    return await readFile(compiledPath, 'utf8');
  } catch (err) {
    try {
      const srcPath = join(here, '..', 'src', 'templates', 'community-verify.mjml');
      return await readFile(srcPath, 'utf8');
    } catch {
      logger.warn({ err }, '[email] MJML template not found; using inline fallback');
      return INLINE_FALLBACK_MJML;
    }
  }
}

export type VerifyEmailPayload = {
  to: string;
  token: string;
  verifyBaseUrl: string;
  affiliation?: string;
  redirectPath?: string;
  brandName?: string;
};

type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  messageId: string;
};

function signLink(url: string): string {
  const secret = env.EMAIL_LINK_SIGNING_SECRET ?? '';
  const h = createHash('sha256').update(`${url}:${secret}`).digest('hex').slice(0, 16);
  const sep = url.includes('?') ? '&' : '?';
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

function brandName(payload: VerifyEmailPayload): string {
  return payload.brandName ?? env.OTEL_SERVICE_NAME ?? 'Bowdoin Marketplace';
}

/** Lightweight rendering (no MJML/uglify chain). Used for EMAIL_PROVIDER=log. */
function renderLite(payload: VerifyEmailPayload): RenderedEmail {
  const url = verificationUrl(payload);
  const brand = brandName(payload);
  const subject =
    (payload.affiliation ?? '').toLowerCase() === 'community'
      ? `${brand}: Verify your community email`
      : `${brand}: Verify your email`;

  const text = [
    `Verify your email for ${brand}`,
    '',
    `Hello ${payload.to},`,
    'Please click the link below to verify your email:',
    url,
    '',
    'If you did not request this, you can ignore this message.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<meta charset="utf-8" />',
    `<title>${subject}</title>`,
    `<h2 style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif">${subject}</h2>`,
    `<p>Hello ${payload.to},</p>`,
    `<p>Please click the button below to verify your email.</p>`,
    `<p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#1f70ff;color:#fff;border-radius:6px;text-decoration:none">Verify email</a></p>`,
    `<p>If the button doesn’t work, copy this link into your browser:<br/><a href="${url}">${url}</a></p>`,
  ].join('\n');

  return { subject, html, text, messageId: randomUUID() };
}

/** Full MJML rendering (lazy heavy deps). Used only for SES/SMTP. */
async function renderMjml(payload: VerifyEmailPayload): Promise<RenderedEmail> {
  const [{ default: mjml }, { default: juice }, { htmlToText }] = await Promise.all([
    import('mjml'),
    import('juice'),
    import('html-to-text'),
  ]);

  const mjmlSource = await loadCommunityTemplate();
  const ctaUrl = verificationUrl(payload);
  const brand = brandName(payload);

  const rendered = mjmlSource
    .replaceAll('{{APP_NAME}}', brand)
    .replaceAll('{{CTA_URL}}', ctaUrl)
    .replaceAll('{{RECIPIENT}}', payload.to)
    .replaceAll('{{AFFILIATION}}', payload.affiliation ?? '')
    .replaceAll('{{SUPPORT_EMAIL}}', env.EMAIL_SUPPORT_ADDRESS ?? env.EMAIL_FROM);

  const { html: mjmlHtml, errors } = mjml(rendered, {
    validationLevel: 'strict',
    minify: true,
    keepComments: false,
  });

  if (errors?.length) {
    logger.warn(
      {
        errors: errors.map((e: unknown) => {
          const obj = e as { line?: number; message?: string };
          return { line: obj?.line ?? null, message: obj?.message ?? 'MJML error' };
        }),
      },
      'MJML validation produced warnings/errors',
    );
  }

  const inlined = juice(mjmlHtml);
  const text = htmlToText(inlined, {
    selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }],
    wordwrap: 100,
  });

  const subject =
    (payload.affiliation ?? '').toLowerCase() === 'community'
      ? `${brand}: Verify your community email`
      : `${brand}: Verify your email`;

  return { subject, html: inlined, text, messageId: randomUUID() };
}

/** Build a nodemailer transporter for SMTP (lazy runtime import). */
async function createSmtpTransport(): Promise<Transporter> {
  const provider = (env.EMAIL_PROVIDER ?? 'log').toLowerCase();
  if (provider !== 'smtp') {
    throw new Error('createSmtpTransport called but EMAIL_PROVIDER is not smtp');
  }
  const nodemailer = (await import('nodemailer')).default;

  const secure =
    env.SMTP_SECURE === true || env.SMTP_PORT === 465 || String(env.SMTP_PORT ?? '') === '465';

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
    tls: env.SMTP_TLS_REJECT_UNAUTHORIZED === false ? { rejectUnauthorized: false } : undefined,
  });
}

async function sendViaSes(from: string, to: string, rendered: RenderedEmail) {
  const { SESClient, SendRawEmailCommand } = await import('@aws-sdk/client-ses');

  const region: string = env.AWS_REGION ?? env.S3_REGION ?? 'us-east-1';
  const sesConfig: SESClientConfig = { region };

  const client = new SESClient(sesConfig);

  const boundary = `mixed-${randomUUID()}`;
  const raw = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + rendered.subject,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    rendered.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    rendered.html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

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
 * (Exported API unchanged)
 */
export async function sendVerificationEmail(
  payload: VerifyEmailPayload,
): Promise<{ ok: true; provider: string; messageId: string }> {
  const to = payload.to.trim().toLowerCase();
  const from = env.EMAIL_FROM;
  const provider = (env.EMAIL_PROVIDER ?? 'log').toLowerCase();

  const metaBase = {
    to,
    from,
    provider,
    affiliation: payload.affiliation ?? undefined,
  } as const;

  logger.info(metaBase, 'Preparing verification email');

  try {
    let rendered: RenderedEmail;

    switch (provider) {
      case 'ses': {
        rendered = await renderMjml(payload);
        await sendViaSes(from, to, rendered);
        break;
      }
      case 'smtp': {
        const transporter = await createSmtpTransport();
        if (env.EMAIL_VALIDATE_TRANSPORT === true) {
          await transporter.verify();
        }
        rendered = await renderMjml(payload);
        await sendViaSmtp(transporter, from, to, rendered);
        break;
      }
      case 'log':
      default: {
        // No heavy imports — just log a lightweight preview
        rendered = renderLite(payload);
        logger.info(
          {
            ...metaBase,
            messageId: rendered.messageId,
            subject: rendered.subject,
            previewText: rendered.text.slice(0, 140),
            verifyUrl: verificationUrl(payload),
          },
          '[DEV] Verification email (not sent)',
        );
        break;
      }
    }

    await audit.emit('user.email_verification_sent', {
      outcome: 'success',
      meta: {
        email: to,
        provider,
        affiliation: payload.affiliation ?? undefined,
        messageId: rendered.messageId,
      },
    });

    logger.info({ ...metaBase, messageId: rendered.messageId }, 'Verification email dispatched');
    return { ok: true, provider, messageId: rendered.messageId };
  } catch (err) {
    logger.error({ err, ...metaBase }, 'Failed to dispatch verification email');

    await audit.emit('user.email_verification_sent', {
      outcome: 'failure',
      severity: 'warn',
      meta: {
        email: to,
        provider,
        affiliation: payload.affiliation ?? undefined,
        reason: 'send_failed',
      },
    });

    throw err;
  }
}

/** Preview builder — uses the same branch logic as send (no heavy deps for LOG). */
export async function renderVerificationEmailPreview(
  payload: VerifyEmailPayload,
): Promise<RenderedEmail & { to: string; from: string; url: string }> {
  const provider = (env.EMAIL_PROVIDER ?? 'log').toLowerCase();
  const r = provider === 'log' ? renderLite(payload) : await renderMjml(payload);
  const url = verificationUrl(payload);
  return { ...r, to: payload.to, from: env.EMAIL_FROM, url };
}
