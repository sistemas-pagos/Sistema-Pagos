import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import type { HomeRecord } from '@/src/domain/types';
import { getPaymentStore } from '@/src/storage';

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
    const stage = Number.parseInt(String(form.get('stage') ?? ''), 10);
    const block = Number.parseInt(String(form.get('block') ?? ''), 10);
    const house = Number.parseInt(String(form.get('house') ?? ''), 10);
    const monthlyFee = Number.parseFloat(String(form.get('monthlyFee') ?? ''));
    if (!Number.isInteger(stage) || stage <= 0 || !Number.isInteger(block) || block <= 0 || !Number.isInteger(house) || house <= 0) {
      return new NextResponse('Invalid home', { status: 400 });
    }
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
