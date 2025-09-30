export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Page() {
  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
      <p className="mt-2 text-muted-foreground">Moderation tools bootstrapping...</p>
    </main>
  );
}
