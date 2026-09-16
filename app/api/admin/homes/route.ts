import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import type { HomeRecord } from '@/src/domain/types';
import { getPaymentStore } from '@/src/storage';
import { isValidHome, normalizeHomePart } from '@/src/domain/housing';

export const runtime = 'nodejs';

function optionalDate(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('invalid_date');
  return text;
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  try {
    const form = await request.formData();
    const stage = normalizeHomePart(String(form.get('stage') ?? ''));
    const block = normalizeHomePart(String(form.get('block') ?? ''));
    const house = normalizeHomePart(String(form.get('house') ?? ''));
    if (!isValidHome(stage, block, house)) {
      return new NextResponse('Invalid home', { status: 400 });
    }
    const monthlyFee = Number.parseFloat(String(form.get('monthlyFee') ?? ''));
    if (!Number.isFinite(monthlyFee) || monthlyFee <= 0 || monthlyFee > 1_000_000) {
      return new NextResponse('Invalid monthly fee', { status: 400 });
    }

    const responsible = String(form.get('responsible') ?? '').trim().slice(0, 160) || undefined;
    const startDate = optionalDate(form.get('startDate'));
    const store = await getPaymentStore();
    const home: HomeRecord = {
      id: `home-e${stage}-b${block}-c${house}`,
      stage,
      block,
      house,
      responsible,
      monthlyFee,
      active: true,
      startDate,
    };
    await store.saveHome(home);
    return NextResponse.redirect(new URL('/admin/homes?created=1', request.url), 303);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_home';
    if (reason === 'home_already_exists' || reason === 'home_address_already_exists') {
      return new NextResponse('Home already exists', { status: 409 });
    }
    return new NextResponse('Invalid home data', { status: 400 });
  }
}
