import { defineStore } from "pinia";
import { computed, reactive } from "vue";
import type {
  Correction,
  Customer,
  DB,
  LedgerEntry,
  Order,
  PayMethod,
  Refund,
  Shift
} from "./types";

const STORAGE_KEY = "dfwlfront-7-settlement-v1";

export const FUEL_TYPES = ["92#汽油", "95#汽油", "98#汽油", "0#柴油"] as const;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const fmtMoney = (n: number) =>
  (n < 0 ? "-" : "") +
  "¥" +
  Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------- 种子数据：一班已冻结 + 一班进行中 ---------------- */

function seed(): DB {
  const t = (daysAgo: number, hour: number) => {
    const d = new Date("2026-09-19T08:00:00+08:00");
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  const customers: Customer[] = [
    { id: "c-zhang", name: "张伟", phone: "13800000001", createdAt: t(2, 9) },
    { id: "c-li", name: "李娜", phone: "13800000002", createdAt: t(2, 10) },
    { id: "c-wang", name: "王强", phone: "13800000003", createdAt: t(1, 14) }
  ];

  const shifts: Shift[] = [
    { id: "s-1", code: "2026-09-18 早班", openedAt: t(1, 8), closedAt: t(1, 16), openingCash: 1000 },
    { id: "s-2", code: "2026-09-19 早班", openedAt: t(0, 8), closedAt: null, openingCash: 1200 }
  ];

  const ledger: LedgerEntry[] = [
    { id: "l-1", shiftId: "s-1", customerId: "c-zhang", kind: "topup", amount: 2000, orderId: null, refundId: null, correctionId: null, balanceAfter: 2000, createdAt: t(1, 9) },
    { id: "l-2", shiftId: "s-1", customerId: "c-li", kind: "topup", amount: 500, orderId: null, refundId: null, correctionId: null, balanceAfter: 500, createdAt: t(1, 9) },
    { id: "l-3", shiftId: "s-1", customerId: "c-wang", kind: "topup", amount: 300, orderId: null, refundId: null, correctionId: null, balanceAfter: 300, createdAt: t(1, 14) },
    { id: "l-4", shiftId: "s-1", customerId: "c-zhang", kind: "sale", amount: -319.8, orderId: "o-1", refundId: null, correctionId: null, balanceAfter: 1680.2, createdAt: t(1, 10) },
    { id: "l-5", shiftId: "s-1", customerId: "c-li", kind: "sale", amount: -210, orderId: "o-2", refundId: null, correctionId: null, balanceAfter: 290, createdAt: t(1, 11) },
    { id: "l-6", shiftId: "s-1", customerId: "c-wang", kind: "sale", amount: -150, orderId: "o-3", refundId: null, correctionId: null, balanceAfter: 150, createdAt: t(1, 14) },
    { id: "l-7", shiftId: "s-1", customerId: "c-li", kind: "refund_credit", amount: 210, orderId: "o-2", refundId: "r-1", correctionId: null, balanceAfter: 500, createdAt: t(1, 15) }
  ];

  const orders: Order[] = [
    { id: "o-1", code: "JY20260918-001", shiftId: "s-1", customerId: "c-zhang", fuelType: "95#汽油", liters: 42.64, unitPrice: 7.5, amount: 319.8, method: "stored", balanceAfter: 1680.2, createdAt: t(1, 10) },
    { id: "o-2", code: "JY20260918-002", shiftId: "s-1", customerId: "c-li", fuelType: "92#汽油", liters: 28, unitPrice: 7.5, amount: 210, method: "stored", balanceAfter: 290, createdAt: t(1, 11) },
    { id: "o-3", code: "JY20260918-003", shiftId: "s-1", customerId: "c-wang", fuelType: "0#柴油", liters: 20, unitPrice: 7.5, amount: 150, method: "stored", balanceAfter: 150, createdAt: t(1, 14) },
    { id: "o-4", code: "JY20260918-004", shiftId: "s-1", customerId: null, fuelType: "92#汽油", liters: 40, unitPrice: 7.5, amount: 300, method: "cash", balanceAfter: null, createdAt: t(1, 13) },
    { id: "o-5", code: "JY20260918-005", shiftId: "s-1", customerId: null, fuelType: "95#汽油", liters: 40, unitPrice: 7.75, amount: 310, method: "digital", balanceAfter: null, createdAt: t(1, 15) }
  ];

  const refunds: Refund[] = [
    // 同班退款（原班 s-1 内完成），直接补卡
    { id: "r-1", code: "TK20260918-001", orderId: "o-2", shiftId: "s-1", amount: 210, reason: "油枪跳枪异常，全额退款", crossShift: false, correctionId: null, balanceAfter: 500, createdAt: t(1, 15) }
  ];

  return { version: 1, customers, shifts, orders, refunds, corrections: [], ledger };
}

function load(): DB {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const db = seed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    return db;
  }
  try {
    const parsed = JSON.parse(raw) as DB;
    if (!parsed.version || !Array.isArray(parsed.ledger)) throw new Error("bad db");
    return parsed;
  } catch {
    // 数据损坏时回退到种子数据，避免半份账本造成错账
    const db = seed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    return db;
  }
}

/* ---------------- Store ---------------- */

export const useSettlementStore = defineStore("settlement", () => {
  const db = reactive<DB>(load());

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function resetDemo() {
    const fresh = seed();
    Object.assign(db, fresh);
    persist();
  }

  /* ---- 查询 ---- */

  const openShift = computed<Shift | null>(
    () => db.shifts.find((s) => s.closedAt === null) ?? null
  );

  function customer(id: string | null): Customer | null {
    if (!id) return null;
    return db.customers.find((c) => c.id === id) ?? null;
  }

  function shift(id: string): Shift | undefined {
    return db.shifts.find((s) => s.id === id);
  }

  function order(id: string): Order | undefined {
    return db.orders.find((o) => o.id === id);
  }

  /** 客户储值余额 = 全部储值流水净额（实时推导，非缓存字段） */
  const customerBalance = (customerId: string) =>
    round2(
      db.ledger
        .filter((e) => e.customerId === customerId)
        .reduce((sum, e) => sum + e.amount, 0)
    );

  /** 订单已退金额（由退款单推导，订单本身永不修改） */
  const orderRefunded = (orderId: string) =>
    round2(db.refunds.filter((r) => r.orderId === orderId).reduce((s, r) => s + r.amount, 0));

  function shiftOrders(shiftId: string) {
    return db.orders.filter((o) => o.shiftId === shiftId);
  }

  function shiftRefunds(shiftId: string) {
    // 本班受理的退款（含跨班退款，现金/电子从本班支出，储值由原班冲正补回）
    return db.refunds.filter((r) => r.shiftId === shiftId);
  }

  function shiftCorrections(shiftId: string) {
    return db.corrections.filter((c) => c.shiftId === shiftId);
  }

  /** 班次分项汇总 */
  function shiftTotals(shiftId: string) {
    const orders = shiftOrders(shiftId);
    const refunds = shiftRefunds(shiftId);
    const corrections = shiftCorrections(shiftId);

    const sale = (m: PayMethod) =>
      round2(orders.filter((o) => o.method === m).reduce((s, o) => s + o.amount, 0));

    // 本班订单在本班受理的退款（同班退款）
    const sameShiftRefund = (m: PayMethod) =>
      round2(
        refunds
          .filter((r) => !r.crossShift && order(r.orderId)?.method === m)
          .reduce((s, r) => s + r.amount, 0)
      );

    // 本班受理的跨班退款（资金在本班支出）
    const crossShiftRefund = (m: PayMethod) =>
      round2(
        refunds
          .filter((r) => r.crossShift && order(r.orderId)?.method === m)
          .reduce((s, r) => s + r.amount, 0)
      );

    // 原班冲正额（冻结后由跨班退款补记，按支付方式分摊）
    const corrected = (m: PayMethod) =>
      round2(corrections.filter((c) => c.kind === m).reduce((s, c) => s + c.amount, 0));

    // 储值净销售（流水口径；sale 为负、refund_credit 为正，取反得正向净额。
    // 跨班退款补回流水挂原班，天然计入原班）
    const storedSigned = round2(
      db.ledger
        .filter((e) => e.shiftId === shiftId && (e.kind === "sale" || e.kind === "refund_credit"))
        .reduce((s, e) => s + e.amount, 0)
    );
    const storedSales = sale("stored");
    const storedNet = round2(-storedSigned);
    const storedReversed = round2(storedSales - storedNet); // 同班退款 + 跨班冲正补回
    const topup = round2(
      db.ledger.filter((e) => e.shiftId === shiftId && e.kind === "topup").reduce((s, e) => s + e.amount, 0)
    );

    const cashHandover = round2(
      (shift(shiftId)?.openingCash ?? 0) + sale("cash") - sameShiftRefund("cash")
    );

    return {
      storedSales,
      storedReversed,
      storedNet,
      topup,
      cashSales: sale("cash"),
      cashRefundIn: sameShiftRefund("cash"),
      cashCorrectedOut: corrected("cash"),
      cashCrossOut: crossShiftRefund("cash"),
      cashNet: round2(sale("cash") - sameShiftRefund("cash") - corrected("cash")),
      cashHandover,
      digitalSales: sale("digital"),
      digitalRefundIn: sameShiftRefund("digital"),
      digitalCorrectedOut: corrected("digital"),
      digitalCrossOut: crossShiftRefund("digital"),
      digitalNet: round2(sale("digital") - sameShiftRefund("digital") - corrected("digital"))
    };
  }

  /* ---- 写入（全部追加 + 原子落盘） ---- */

  function openNewShift(code: string, openingCash: number) {
    if (openShift.value) throw new Error("已有进行中的班次，请先交班");
    if (!code.trim()) throw new Error("请填写班次名称");
    if (Number.isNaN(openingCash) || openingCash < 0) throw new Error("备用金金额无效");
    const s: Shift = {
      id: uid("s"),
      code: code.trim(),
      openedAt: new Date().toISOString(),
      closedAt: null,
      openingCash: round2(openingCash)
    };
    db.shifts.push(s);
    persist();
  }

  function closeShift() {
    const s = openShift.value;
    if (!s) throw new Error("没有进行中的班次");
    s.closedAt = new Date().toISOString();
    persist();
  }

  function addCustomer(name: string, phone: string, initialTopup: number): Customer {
    if (!name.trim()) throw new Error("请填写客户姓名");
    const s = openShift.value;
    if (!s) throw new Error("当前无进行中班次，无法开卡");
    const c: Customer = { id: uid("c"), name: name.trim(), phone: phone.trim(), createdAt: new Date().toISOString() };
    db.customers.push(c);
    const amount = round2(initialTopup || 0);
    if (amount > 0) {
      db.ledger.push({
        id: uid("l"),
        shiftId: s.id,
        customerId: c.id,
        kind: "topup",
        amount,
        orderId: null,
        refundId: null,
        correctionId: null,
        balanceAfter: amount,
        createdAt: new Date().toISOString()
      });
    }
    persist();
    return c;
  }

  function topup(customerId: string, amount: number) {
    const s = openShift.value;
    if (!s) throw new Error("当前无进行中班次，无法充值");
    const c = customer(customerId);
    if (!c) throw new Error("客户不存在");
    if (Number.isNaN(amount) || amount <= 0) throw new Error("充值金额必须大于 0");
    const value = round2(amount);
    db.ledger.push({
      id: uid("l"),
      shiftId: s.id,
      customerId,
      kind: "topup",
      amount: value,
      orderId: null,
      refundId: null,
      correctionId: null,
      balanceAfter: round2(customerBalance(customerId) + value),
      createdAt: new Date().toISOString()
    });
    persist();
  }

  function nextSeq(items: { code: string }[], prefix: string, ymd: string) {
    const n =
      items.filter((x) => x.code.includes(ymd)).length + 1;
    return `${prefix}${ymd}-${String(n).padStart(3, "0")}`;
  }

  function createOrder(input: {
    customerId: string | null;
    fuelType: string;
    liters: number;
    unitPrice: number;
    method: PayMethod;
  }): Order {
    const s = openShift.value;
    if (!s) throw new Error("当前班次已交班并冻结，新订单请开班后录入");
    if (!input.fuelType) throw new Error("请选择油品");
    if (!(input.liters > 0)) throw new Error("加油升数必须大于 0");
    if (!(input.unitPrice > 0)) throw new Error("单价必须大于 0");

    const amount = round2(input.liters * input.unitPrice);

    // 规则：整笔订单从储值余额扣款，余额不足时不能保存，必须改用现金或电子支付
    if (input.method === "stored") {
      if (!input.customerId) throw new Error("散客不能使用储值支付，请改用现金或电子支付");
      const balance = customerBalance(input.customerId);
      if (balance < amount) {
        throw new Error(
          `储值余额不足：余额 ${fmtMoney(balance)}，本单应付 ${fmtMoney(amount)}，不能保存，请改用现金或电子支付`
        );
      }
    }

    const nowIso = new Date().toISOString();
    const ymd = nowIso.slice(0, 10).replace(/-/g, "");
    const orderId = uid("o");
    let balanceAfter: number | null = null;

    if (input.method === "stored" && input.customerId) {
      balanceAfter = round2(customerBalance(input.customerId) - amount);
      db.ledger.push({
        id: uid("l"),
        shiftId: s.id,
        customerId: input.customerId,
        kind: "sale",
        amount: -amount,
        orderId,
        refundId: null,
        correctionId: null,
        balanceAfter,
        createdAt: nowIso
      });
    }

    const o: Order = {
      id: orderId,
      code: nextSeq(db.orders, "JY", ymd),
      shiftId: s.id,
      customerId: input.customerId,
      fuelType: input.fuelType,
      liters: round2(input.liters),
      unitPrice: round2(input.unitPrice),
      amount,
      method: input.method,
      balanceAfter,
      createdAt: nowIso
    };
    db.orders.push(o);
    persist();
    return o;
  }

  /** 规则：退款只能引用已结算订单，且不得超过原订单实付（扣减已退） */
  function createRefund(input: { orderId: string; amount: number; reason: string }): Refund {
    const s = openShift.value;
    if (!s) throw new Error("当前无进行中班次，无法受理退款");
    const o = order(input.orderId);
    if (!o) throw new Error("只能引用已结算订单");
    if (!(input.amount > 0)) throw new Error("退款金额必须大于 0");
    const amount = round2(input.amount);
    if (!input.reason.trim()) throw new Error("请填写退款原因");

    const already = orderRefunded(o.id);
    const remain = round2(o.amount - already);
    if (remain <= 0) throw new Error("该订单已全额退款");
    if (amount > remain) {
      throw new Error(`退款不得超过原订单实付金额：本单 ${fmtMoney(o.amount)}，已退 ${fmtMoney(already)}，最多可退 ${fmtMoney(remain)}`);
    }

    const originalShift = shift(o.shiftId);
    if (!originalShift) throw new Error("原班次不存在");
    const crossShift = o.shiftId !== s.id; // 原班已冻结 => 必为跨班

    const nowIso = new Date().toISOString();
    const ymd = nowIso.slice(0, 10).replace(/-/g, "");
    const refundId = uid("r");
    const refundCode = nextSeq(db.refunds, "TK", ymd);
    let correctionId: string | null = null;
    let balanceAfter: number | null = null;

    const totalsBefore = shiftTotals(o.shiftId);
    const salesBefore =
      o.method === "stored"
        ? totalsBefore.storedSales
        : o.method === "cash"
          ? totalsBefore.cashSales
          : totalsBefore.digitalSales;
    const refundedBefore =
      o.method === "stored"
        ? totalsBefore.storedReversed
        : o.method === "cash"
          ? round2(totalsBefore.cashRefundIn + totalsBefore.cashCorrectedOut)
          : round2(totalsBefore.digitalRefundIn + totalsBefore.digitalCorrectedOut);

    if (crossShift) {
      // 规则：跨班退款必须先补回原班余额，再计入当前班
      // 做法：在原班追加一条带原因的冲正记录（保留旧值），资金从当前班支出
      correctionId = uid("x");
      const c: Correction = {
        id: correctionId,
        code: nextSeq(db.corrections, "CZ", ymd),
        shiftId: o.shiftId,
        orderId: o.id,
        refundId,
        kind: o.method,
        reason: input.reason.trim(),
        amount,
        oldValue: {
          orderAmount: o.amount,
          shiftSalesBefore: salesBefore,
          shiftRefundedBefore: refundedBefore,
          shiftNetAfter: round2(salesBefore - refundedBefore - amount),
          customerBalanceBefore: o.customerId ? customerBalance(o.customerId) : null
        },
        createdAt: nowIso
      };
      db.corrections.push(c);

      if (o.method === "stored" && o.customerId) {
        // 补回原班：流水挂原班，原班储值净额随之回冲
        balanceAfter = round2(customerBalance(o.customerId) + amount);
        db.ledger.push({
          id: uid("l"),
          shiftId: o.shiftId,
          customerId: o.customerId,
          kind: "refund_credit",
          amount,
          orderId: o.id,
          refundId,
          correctionId,
          balanceAfter,
          createdAt: nowIso
        });
      }
      // 现金/电子：原班收入通过冲正记录核销，现金由当前班支出（电子为平台冲抵）
    } else if (o.method === "stored" && o.customerId) {
      // 同班储值退款直接补卡，流水归属本班
      balanceAfter = round2(customerBalance(o.customerId) + amount);
      db.ledger.push({
        id: uid("l"),
        shiftId: o.shiftId,
        customerId: o.customerId,
        kind: "refund_credit",
        amount,
        orderId: o.id,
        refundId,
        correctionId: null,
        balanceAfter,
        createdAt: nowIso
      });
    }

    const r: Refund = {
      id: refundId,
      code: refundCode,
      orderId: o.id,
      shiftId: s.id,
      amount,
      reason: input.reason.trim(),
      crossShift,
      correctionId,
      balanceAfter,
      createdAt: nowIso
    };
    db.refunds.push(r);
    persist();
    return r;
  }

  /** 一致性自检：流水余额、退款上限、冻结班次不可变结构 */
  function audit(): string[] {
    const problems: string[] = [];
    for (const c of db.customers) {
      const sum = round2(db.ledger.filter((e) => e.customerId === c.id).reduce((s, e) => s + e.amount, 0));
      const chain = db.ledger.filter((e) => e.customerId === c.id);
      const last = chain.length ? chain.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[chain.length - 1] : null;
      if (last && round2(last.balanceAfter) !== sum) {
        problems.push(`客户 ${c.name} 流水余额 ${fmtMoney(sum)} 与末次快照 ${fmtMoney(last.balanceAfter)} 不一致`);
      }
      if (sum < 0) problems.push(`客户 ${c.name} 储值余额为负（${fmtMoney(sum)}）`);
    }
    for (const o of db.orders) {
      const refunded = orderRefunded(o.id);
      if (round2(refunded - o.amount) > 0.0001) problems.push(`订单 ${o.code} 累计退款超过实付金额`);
    }
    const openCount = db.shifts.filter((s) => s.closedAt === null).length;
    if (openCount > 1) problems.push(`存在 ${openCount} 个未交班班次`);
    return problems;
  }

  return {
    db,
    openShift,
    shift,
    order,
    customer,
    customerBalance,
    orderRefunded,
    shiftOrders,
    shiftRefunds,
    shiftCorrections,
    shiftTotals,
    createOrder,
    createRefund,
    addCustomer,
    topup,
    openNewShift,
    closeShift,
    resetDemo,
    audit
  };
});
