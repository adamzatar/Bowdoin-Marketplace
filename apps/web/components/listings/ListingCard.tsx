// bootstrap placeholder — created by setup script
"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";

export type ListingCardProps = {
  id: string;
  title: string;
  priceCents: number;
  coverUrl?: string;
  alt?: string;
};

export function ListingCard({
  id,
  title,
  priceCents,
  coverUrl,
  alt,
}: ListingCardProps) {
  const price = useMemo(
    () => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(priceCents / 100),
    [priceCents]
  );

  return (
    <article className="ui-card overflow-hidden h-full flex flex-col">
      <Link
        href={`/listings/${id}`}
        className="block focus-visible:outline-2 focus-visible:outline-[hsl(var(--focus))]"
        aria-label={`${title} — ${price}`}
      >
        <div className="relative aspect-[4/3] bg-muted">
          {coverUrl ? (
            <Image
              src={coverUrl}
              alt={alt ? alt : title}
              fill
              sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              className="object-cover"
            />
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 grid place-content-center text-muted-foreground"
            >
              No image
            </div>
          )}
        </div>
        <div className="p-4 space-y-1">
          <h2 className="text-lg font-semibold line-clamp-2">{title}</h2>
          <p className="text-secondary-foreground bg-secondary inline-block px-2 py-0.5 rounded">
            {price}
          </p>
        </div>
      </Link>
    </article>
  );
}
