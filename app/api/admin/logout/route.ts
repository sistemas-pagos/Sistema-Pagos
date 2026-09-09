import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isSameOriginRequest } from '@/src/auth/guard';
import { ADMIN_SESSION_COOKIE } from '@/src/auth/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
