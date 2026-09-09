import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isDemoMode } from '@/src/config/env';
import { isSameOriginRequest } from '@/src/auth/guard';
import { ADMIN_COOKIE_OPTIONS, ADMIN_SESSION_COOKIE, createAdminSession, verifyAdminAccessKey } from '@/src/auth/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (isDemoMode()) return NextResponse.redirect(new URL('/', request.url), 303);
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const form = await request.formData();
  const accessKey = String(form.get('accessKey') ?? '');
  if (!verifyAdminAccessKey(accessKey)) {
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303);
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE, createAdminSession(), ADMIN_COOKIE_OPTIONS);
  return NextResponse.redirect(new URL('/admin', request.url), 303);
}
