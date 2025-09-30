// apps/web/app/login/page.tsx
import SignInClient from "./signin-client";

export const dynamic = "force-dynamic"; // always render fresh in dev

export default function LoginPage() {
  return (
    <main className="min-h-svh flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 bg-white/70 dark:bg-neutral-900/60 shadow-sm backdrop-blur-md p-6 space-y-6">
        <header className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="text-sm text-neutral-500">
            Choose a provider to continue.
          </p>
        </header>
        <SignInClient />
      </div>
    </main>
  );
}
