"use client";

import { useEffect, useMemo, useState } from "react";
import { getProviders, signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

type Provider = {
  id: string;
  name: string;
  type: "oauth" | "email" | "credentials";
};

export default function SignInClient() {
  const [providers, setProviders] = useState<Record<string, Provider> | null>(null);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState<"dev" | "email" | "okta" | null>(null);

  const params = useSearchParams();
  const callbackUrl = params?.get("callbackUrl") ?? "/";

  useEffect(() => {
    void (async () => {
      const p = await getProviders();
      setProviders((p ?? null) as Record<string, Provider> | null);
    })();
  }, []);

  const has = useMemo(() => {
    return (id: string) => Boolean(providers && providers[id]);
  }, [providers]);

  if (!providers) {
    return <div className="text-sm text-neutral-500">Loading providers…</div>;
  }

  return (
    <div className="space-y-3">
      {/* Dev Credentials (if ENABLE_DEV_LOGIN=true on server) */}
      {has("dev") && (
        <button
          onClick={() => {
            // Supply minimal credentials so Credentials provider authorizes.
            const devEmail = email.trim() || "dev@example.test";
            setSubmitting("dev");
            void signIn("dev", {
              callbackUrl,
              redirect: true,
              email: devEmail,
              name: "Dev User",
            }).finally(() => setSubmitting((prev) => (prev === "dev" ? null : prev)));
          }}
          disabled={submitting !== null}
          className="w-full rounded-md bg-black text-white py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting === "dev" ? "Signing in…" : "Continue with Dev"}
        </button>
      )}

      {/* Okta (optional) */}
      {has("okta") && (
        <button
          onClick={() => {
            setSubmitting("okta");
            void signIn("okta", { callbackUrl, redirect: true }).finally(() =>
              setSubmitting((prev) => (prev === "okta" ? null : prev)),
            );
          }}
          disabled={submitting !== null}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting === "okta" ? "Redirecting to Okta…" : "Continue with Okta"}
        </button>
      )}

      {/* Email (magic link) */}
      {has("email") && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email) return;
            setSubmitting("email");
            void signIn("email", { email, callbackUrl, redirect: true }).finally(() =>
              setSubmitting((prev) => (prev === "email" ? null : prev)),
            );
          }}
        >
          <label htmlFor="login-email" className="block text-sm text-neutral-600 dark:text-neutral-400">
            Email address
          </label>
          <input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@bowdoin.edu"
            autoComplete="email"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm outline-none focus:ring-2 ring-blue-500/30"
          />
          <button
            type="submit"
            disabled={submitting !== null}
            className="w-full rounded-md bg-blue-600 text-white py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting === "email" ? "Sending link…" : "Send magic link"}
          </button>
        </form>
      )}
    </div>
  );
}
