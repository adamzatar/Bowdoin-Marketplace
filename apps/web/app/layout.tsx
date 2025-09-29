// apps/web/app/layout.tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Bowdoin Marketplace',
  description: 'Campus marketplace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body>{children}</body>
    </html>
  );
}