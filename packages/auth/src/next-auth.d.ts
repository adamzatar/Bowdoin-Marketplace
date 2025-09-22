// packages/auth/src/next-auth.d.ts
import 'next-auth';
import type { JWT as BaseJWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user?: {
      id?: string;
      email?: string | null;
      roles?: string[];
      name?: string | null;
      image?: string | null;
    } | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends BaseJWT {
    userId?: string;
    roles?: string[];
  }
}
