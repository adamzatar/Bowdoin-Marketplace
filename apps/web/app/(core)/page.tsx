import HomePageClient from "./page.client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function HomePage() {
  return <HomePageClient />;
}
