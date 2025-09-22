import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { applyCSPAndSecurityHeaders } from '@/middleware/cspHeaders';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  return applyCSPAndSecurityHeaders(request, response);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
