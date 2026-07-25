import { describe, it, expect } from 'vitest';
import WorkHoursOrder from '../../models/WorkHoursOrder.js';
import mongoose from 'mongoose';

const base = () => ({
  contractor_id: new mongoose.Types.ObjectId(),
  trade_id:      new mongoose.Types.ObjectId(),
  date:          '2026-03-02',
});

// order_sum is what the contractor is charged and what the trade pro is paid, so
// the pre-save hook's arithmetic is pinned including the rounding and the
// null-rate cases that used to silently produce NaN.
describe('WorkHoursOrder pre-save hook', () => {
  it('computes hours × rate × workers', async () => {
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: 50, workers_no: 3 });
    expect(order.order_sum).toBe(1200);
  });

  it('defaults workers_no to 1 when absent', async () => {
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: 50 });
    expect(order.workers_no).toBe(1);
    expect(order.order_sum).toBe(400);
  });

  it('rounds to 2 decimal places rather than carrying float drift', async () => {
    // 7.35 × 33.33 = 244.9755 — must not persist as 244.97549999999998
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 7.35, hourly_rate: 33.33, workers_no: 1 });
    expect(order.order_sum).toBe(244.98);
  });

  it('yields 0 — not NaN — when the trade pro has no hourly rate', async () => {
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: null });
    expect(order.order_sum).toBe(0);
  });

  it('recomputes on every save, not just on create', async () => {
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: 50 });
    order.actual_hours = 10;
    await order.save();
    expect(order.order_sum).toBe(500);
  });

  it('leaves order_sum untouched on findByIdAndUpdate so approval can freeze the amount', async () => {
    // updatePaymentApproval intentionally bypasses the hook to lock in the sum.
    // If the hook ever started firing here, a later rate change would silently
    // rewrite a historical, already-paid amount.
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: 50 });
    await WorkHoursOrder.findByIdAndUpdate(order._id, { hourly_rate: 999 });

    const reloaded = await WorkHoursOrder.findById(order._id).lean();
    expect(reloaded.hourly_rate).toBe(999);
    expect(reloaded.order_sum).toBe(400);
  });

  it('defaults the payout-blocked tracking fields to null', async () => {
    const order = await WorkHoursOrder.create({ ...base(), actual_hours: 8, hourly_rate: 50 });
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.payoutBlockedCode).toBeNull();
    expect(order.payoutBlockedReason).toBeNull();
  });
});
