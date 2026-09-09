import { NextResponse } from 'next/server';
import { isAdminAuthenticated, isSameOriginRequest } from '@/src/auth/guard';
import { isPeriod } from '@/src/domain/periods';
import { buildManualVerificationUpdate } from '@/src/services/manual-verification';
import { assignServicePeriod, hasPeriodConflict } from '@/src/services/period-assignment';
import { getPaymentStore } from '@/src/storage';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) return new NextResponse('Unauthorized', { status: 401 });
  if (!isSameOriginRequest(request)) return new NextResponse('Forbidden', { status: 403 });

  const { id } = await params;
  const store = await getPaymentStore();
  const payment = await store.getPayment(id);
  if (!payment) return new NextResponse('Payment not found', { status: 404 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const returnPeriod = String(form.get('period') ?? payment.period);

  if (action === 'set-period') {
    const newPeriod = String(form.get('newPeriod') ?? '');
    if (!isPeriod(newPeriod)) return new NextResponse('Invalid period', { status: 400 });

    const allPayments = await store.listPayments();
    const clearsOldPeriodConflict = payment.reviewReason === 'service_period_already_has_payment';
    let updated = {
      ...payment,
      period: newPeriod,
      status: clearsOldPeriodConflict ? 'PENDIENTE_VERIFICACION' as const : payment.status,
      reviewReason: clearsOldPeriodConflict ? undefined : payment.reviewReason,
      updatedAt: new Date().toISOString(),
    };

    if (hasPeriodConflict(updated, allPayments)) {
      updated = { ...updated, status: 'EN_REVISION' as const, reviewReason: 'service_period_already_has_payment' };
    }

    await store.updatePayment(updated);
    return NextResponse.redirect(new URL(`/admin?period=${encodeURIComponent(returnPeriod)}`, request.url), 303);
  }

  if (action === 'verify-manually' || action === 'verify-reviewed') {
    try {
      const allPayments = await store.listPayments();
      await store.updatePayment(buildManualVerificationUpdate(payment, allPayments, new Date(), action === 'verify-reviewed'));
    } catch {
      return new NextResponse('Payment is not eligible for manual verification', { status: 409 });
    }
    return NextResponse.redirect(new URL(`/admin?period=${encodeURIComponent(returnPeriod)}`, request.url), 303);
  }

  if (action === 'mark-duplicate') {
    if (payment.status !== 'EN_REVISION' || !payment.duplicateOf) {
      return new NextResponse('Payment is not eligible to mark as duplicate', { status: 409 });
    }
    await store.updatePayment({
      ...payment,
      status: 'DUPLICADO',
      duplicateReason: payment.duplicateReason ?? payment.reviewReason ?? 'manual_review_duplicate',
      reviewReason: undefined,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.redirect(new URL(`/admin?period=${encodeURIComponent(returnPeriod)}`, request.url), 303);
  }

  if (action === 'assign-home') {
    const stage = Number.parseInt(String(form.get('stage') ?? ''), 10);
    const block = Number.parseInt(String(form.get('block') ?? ''), 10);
    const house = Number.parseInt(String(form.get('house') ?? ''), 10);
    if (!Number.isInteger(stage) || !Number.isInteger(block) || !Number.isInteger(house) || stage <= 0 || block <= 0 || house <= 0) {
      return new NextResponse('Invalid home', { status: 400 });
    }

    const homes = await store.listHomes();
    const known = homes.find((home) => home.active && home.stage === stage && home.block === block && home.house === house);
    if (!known) return new NextResponse('Home not found', { status: 400 });

    const allPayments = await store.listPayments();
    const home = { stage, block, house };
    const newPeriod = assignServicePeriod(home, payment.transactionDate, allPayments, new Date(), payment.id);
    const reviewReason = payment.reviewReason === 'receipt_home_not_in_master' ? undefined : payment.reviewReason;
    let updated = {
      ...payment,
      stage,
      block,
      house,
      period: newPeriod,
      status: reviewReason ? 'EN_REVISION' as const : 'PENDIENTE_VERIFICACION' as const,
      reviewReason,
      updatedAt: new Date().toISOString(),
    };

    if (hasPeriodConflict(updated, allPayments) && !updated.reviewReason) {
      updated = { ...updated, status: 'EN_REVISION' as const, reviewReason: 'service_period_already_has_payment' };
    }

    await store.updatePayment(updated);
    await store.clearPending(payment.phone);
    return NextResponse.redirect(new URL(`/admin?period=${encodeURIComponent(returnPeriod)}`, request.url), 303);
  }

  return new NextResponse('Unsupported action', { status: 400 });
}
