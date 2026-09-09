import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import { getPaymentStore } from '@/src/storage';

export const runtime = 'nodejs';

function optionalDate(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('invalid_date');
  return text;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const { id } = await params;
  const store = await getPaymentStore();
  const home = (await store.listHomes()).find((candidate) => candidate.id === id);
  if (!home) return new NextResponse('Home not found', { status: 404 });

  try {
    const form = await request.formData();
    const monthlyFee = Number.parseFloat(String(form.get('monthlyFee') ?? ''));
    if (!Number.isFinite(monthlyFee) || monthlyFee <= 0 || monthlyFee > 1_000_000) {
      return new NextResponse('Invalid monthly fee', { status: 400 });
    }
    const responsible = String(form.get('responsible') ?? '').trim().slice(0, 160) || undefined;
    const startDate = optionalDate(form.get('startDate'));
    const endDate = optionalDate(form.get('endDate'));
    if (startDate && endDate && startDate > endDate) return new NextResponse('Invalid date range', { status: 400 });

    await store.updateHome({
      ...home,
      responsible,
      monthlyFee,
      active: form.get('active') === 'on',
      startDate,
      endDate,
    });
    return NextResponse.redirect(new URL('/admin/homes?updated=1', request.url), 303);
  } catch {
    return new NextResponse('Invalid home data', { status: 400 });
  }
}
