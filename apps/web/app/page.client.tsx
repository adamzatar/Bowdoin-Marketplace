"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/fetcher";
import { ListingCard } from "@/components/listings/ListingCard";
import type { ListingCardProps } from "@/components/listings/ListingCard";

type Listing = {
  id: string;
  title: string;
  priceCents: number;
  coverUrl?: string | null;
  alt?: string | null;
};

type ListingsResponse = {
  items: Listing[];
  nextCursor?: string | null;
};

async function fetchListings(): Promise<ListingsResponse> {
  return apiFetch<ListingsResponse>("/api/listings");
}

export default function HomePageClient() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["listings", "page:home"],
    queryFn: fetchListings,
  });

  const items = data?.items ?? [];

  if (isLoading) {
    return (
      <section aria-busy="true" aria-live="polite">
        <h1 className="text-2xl font-bold mb-4">Marketplace Listings</h1>
        <GridSkeleton />
      </section>
    );
  }

  if (isError) {
    const message =
      (error as { message?: string })?.message ?? "Failed to load listings";
    return (
      <section aria-live="polite">
        <h1 className="text-2xl font-bold mb-2">Marketplace Listings</h1>
        <div
          role="alert"
          className="ui-card p-4 border-destructive text-destructive-foreground"
        >
          <p className="mb-2">Something went wrong: {message}</p>
          <button
            className="rounded-md px-3 py-1 border border-border bg-card hover:bg-muted focus-visible:outline-2 focus-visible:outline-[hsl(var(--focus))]"
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-bold mb-4">Marketplace Listings</h1>

      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
          role="list"
        >
          {items.map((it) => {
            const cardProps: ListingCardProps = {
              id: it.id,
              title: it.title,
              priceCents: it.priceCents,
              ...(it.coverUrl != null ? { coverUrl: it.coverUrl } : {}),
              ...(it.alt != null ? { alt: it.alt } : {}),
            };

            return (
              <li key={it.id}>
                <ListingCard {...cardProps} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="ui-card p-3 space-y-3"
          aria-hidden="true"
        >
          <div className="h-40 rounded-md skeleton" />
          <div className="h-4 w-3/4 rounded skeleton" />
          <div className="h-4 w-1/3 rounded skeleton" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const tip = useMemo(
    () =>
      "No items yet. Be the first to post — use the “Post a listing” link above.",
    []
  );
  return (
    <div className="ui-card p-6 text-center">
      <p className="text-lg">{tip}</p>
    </div>
  );
}
