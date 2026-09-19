import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  Customer,
  LedgerEntry,
  Order,
  OrderItem,
  PayMethod,
  PersistShape,
  Refund,
  Reversal,
  Shift
} from "./types";

const STORAGE_KEY = "fuel-stored-value-v1";
const STORAGE_VERSION = 1;

export function yuanToCents(yuan: number | string): number {
  const n = typeof yuan === "string" ? Number(yuan) : yuan;
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 演示种子数据：一个已冻结早班 + 一个进行中中班，含跨班退款场景 */
function seed(): PersistShape {
  const t = (h: number) => new Date(Date.now() - 86400000 + h * 3600000).toISOString();
  const customers: Customer[] = [
    { id: "cus-1", code: "VIP001", name: "张伟", phone: "13800000001", createdAt: t(-48) },
    { id: "cus-2", code: "VIP002", name: "李娜", phone: "13800000002", createdAt: t(-47) }
  ];
  const morning: Shift = {
    id: "shift-1",
    code: "SHIFT-001",
    name: "早班",
    openedAt: t(-26),
    closedAt: t(-18),
    closingBalances: { "cus-1": 20000, "cus-2": 80000 },
    closeNote: "账实一致"
  };
  const afternoon: Shift = {
    id: "shift-2",
    code: "SHIFT-002",
    name: "中班",
    openedAt: t(-2),
    closedAt: null,
    closingBalances: {},
    closeNote: ""
  };
  const orders: Order[] = [
    {
      id: "ord-1",
      code: "O-0001",
      shiftId: "shift-1",
      customerId: "cus-1",
      customerName: "张伟",
      items: [{ fuelType: "92#", liters: 20, price: 750, amount: 15000 }],
      amount: 15000,
      payMethod: "stored",
      status: "settled",
      createdAt: t(-24)
    },
    {
      id: "ord-2",
      code: "O-0002",
      shiftId: "shift-1",
      customerId: null,
      customerName: "散客",
      items: [{ fuelType: "95#", liters: 30, price: 800, amount: 24000 }],
      amount: 24000,
      payMethod: "cash",
      status: "settled",
      createdAt: t(-22)
    },
    {
      id: "ord-3",
      code: "O-0003",
      shiftId: "shift-1",
      customerId: "cus-2",
      customerName: "李娜",
      items: [{ fuelType: "0#", liters: 40, price: 720, amount: 28800 }],
      amount: 28800,
      payMethod: "stored",
      status: "settled",
      createdAt: t(-20)
    }
  ];
  const ledger: LedgerEntry[] = [
    { id: "led-1", customerId: "cus-1", kind: "recharge", amount: 35000, shiftId: "shift-1", refCode: "充值-初始", createdAt: t(-25) },
    { id: "led-2", customerId: "cus-1", kind: "sale", amount: -15000, shiftId: "shift-1", refCode: "O-0001", createdAt: t(-24) },
    { id: "led-3", customerId: "cus-2", kind: "recharge", amount: 108800, shiftId: "shift-1", refCode: "充值-初始", createdAt: t(-25) },
    { id: "led-4", customerId: "cus-2", kind: "sale", amount: -28800, shiftId: "shift-1", refCode: "O-0003", createdAt: t(-20) }
  ];
  return {
    version: STORAGE_VERSION,
    customers,
    shifts: [morning, afternoon],
    orders,
    refunds: [],
    reversals: [],
    ledger,
    seq: { order: 3, refund: 0, reversal: 0, shift: 2 }
  };
}

function load(): PersistShape {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed.version === STORAGE_VERSION) return parsed;
    } catch {
      /* 数据损坏时回落到种子 */
    }
  }
  return seed();
}

export interface NewOrderInput {
  customerId: string | null;
  items: { fuelType: string; liters: number; price: number }[];
  payMethod: PayMethod;
}

export interface NewRefundInput {
  orderId: string;
  amount: number; // 分
  reason: string;
  operator: string;
}

export interface NewReversalInput {
  originShiftId: string;
  originRef: string;
  kind: "refund" | "correction";
  reason: string;
  operator: string;
  oldValue: string;
  newValue: string;
}

export const useAccountStore = defineStore("account", () => {
  const data = ref<PersistShape>(load());

  const customers = computed(() => data.value.customers);
  const shifts = computed(() => data.value.shifts);
  const orders = computed(() => data.value.orders);
  const refunds = computed(() => data.value.refunds);
  const reversals = computed(() => data.value.reversals);
  const ledger = computed(() => data.value.ledger);

  const currentShift = computed(
    () => data.value.shifts.find((s) => s.closedAt === null) ?? null
  );

  // ---------- 余额：储值分户流水求和，任何刷新后结果一致 ----------
  const balances = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const e of data.value.ledger) {
      map[e.customerId] = (map[e.customerId] ?? 0) + e.amount;
    }
    return map;
  });

  function balanceOf(customerId: string | null): number {
    if (!customerId) return 0;
    return balances.value[customerId] ?? 0;
  }

  /** 某班次冻结时的余额快照 */
  function frozenBalance(shiftId: string, customerId: string): number {
    const shift = data.value.shifts.find((s) => s.id === shiftId);
    return shift?.closingBalances[customerId] ?? 0;
  }

  // ---------- 订单累计实付 / 已退，保证退款不超过原订单实付 ----------
  function paidAmount(orderId: string): number {
    return data.value.orders.find((o) => o.id === orderId)?.amount ?? 0;
  }

  function refundedAmount(orderId: string): number {
    return data.value.refunds
      .filter((r) => r.orderId === orderId)
      .reduce((sum, r) => sum + r.amount, 0);
  }

  function remainingRefundable(orderId: string): number {
    return Math.max(0, paidAmount(orderId) - refundedAmount(orderId));
  }

  // ---------- 班次汇总（当前班按流水实时算，冻结班以快照为准） ----------
  interface ShiftSummary {
    shift: Shift;
    cash: number;
    digital: number;
    stored: number;
    refundOut: number; // 本班现金/电子退款支出
    storedRefund: number; // 本班储值退款（补回余额）
    recharge: number;
    orderCount: number;
    refundCount: number;
  }

  const shiftSummaries = computed<ShiftSummary[]>(() =>
    data.value.shifts.map((shift) => {
      const os = data.value.orders.filter((o) => o.shiftId === shift.id);
      const rs = data.value.refunds.filter((r) => r.shiftId === shift.id);
      const recharge = data.value.ledger
        .filter((e) => e.shiftId === shift.id && e.kind === "recharge")
        .reduce((s, e) => s + e.amount, 0);
      return {
        shift,
        cash: os.filter((o) => o.payMethod === "cash").reduce((s, o) => s + o.amount, 0),
        digital: os.filter((o) => o.payMethod === "digital").reduce((s, o) => s + o.amount, 0),
        stored: os.filter((o) => o.payMethod === "stored").reduce((s, o) => s + o.amount, 0),
        refundOut: rs
          .filter((r) => r.payMethod !== "stored")
          .reduce((s, r) => s + r.amount, 0),
        storedRefund: rs
          .filter((r) => r.payMethod === "stored")
          .reduce((s, r) => s + r.amount, 0),
        recharge,
        orderCount: os.length,
        refundCount: rs.length
      };
    })
  );

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data.value));
  }

  function nextSeq(key: string): number {
    data.value.seq[key] = (data.value.seq[key] ?? 0) + 1;
    return data.value.seq[key];
  }

  // ---------- 客户 / 充值 ----------
  function addCustomer(input: { code: string; name: string; phone: string }) {
    data.value.customers.push({
      id: uid("cus"),
      code: input.code.trim(),
      name: input.name.trim(),
      phone: input.phone.trim(),
      createdAt: nowIso()
    });
    persist();
  }

  function recharge(customerId: string, amountCents: number) {
    const shift = currentShift.value;
    if (!shift) throw new Error("当前没有进行中的班次，请先开班");
    if (!(amountCents > 0)) throw new Error("充值金额必须大于 0");
    const code = `CZ-${String(nextSeq("recharge")).padStart(4, "0")}`;
    data.value.ledger.push({
      id: uid("led"),
      customerId,
      kind: "recharge",
      amount: amountCents,
      shiftId: shift.id,
      refCode: code,
      createdAt: nowIso()
    });
    persist();
  }

  // ---------- 开班 / 交班 ----------
  function openShift(name: string) {
    if (currentShift.value) throw new Error("已有进行中的班次，请先交班");
    const seq = nextSeq("shift");
    data.value.shifts.push({
      id: uid("shift"),
      code: `SHIFT-${String(seq).padStart(3, "0")}`,
      name: name.trim() || "当班",
      openedAt: nowIso(),
      closedAt: null,
      closingBalances: {},
      closeNote: ""
    });
    persist();
  }

  /** 交班：对全部储值余额拍快照，此后该班订单与余额冻结 */
  function closeShift(note: string) {
    const shift = currentShift.value;
    if (!shift) throw new Error("当前没有进行中的班次");
    shift.closedAt = nowIso();
    shift.closingBalances = { ...balances.value };
    shift.closeNote = note.trim();
    persist();
  }

  // ---------- 加油订单：整笔订单一次扣款，余额不足禁止保存 ----------
  function createOrder(input: NewOrderInput): Order {
    const shift = currentShift.value;
    if (!shift) throw new Error("当前没有进行中的班次，不能保存订单");

    const items: OrderItem[] = input.items
      .map((it) => {
        const liters = Number(it.liters);
        const price = Number(it.price);
        if (!Number.isFinite(liters) || liters <= 0) return null;
        if (!Number.isFinite(price) || price <= 0) return null;
        return {
          fuelType: it.fuelType.trim() || "油品",
          liters: Math.round(liters * 100) / 100,
          price,
          amount: Math.round(liters * price)
        };
      })
      .filter((x): x is OrderItem => x !== null);

    if (items.length === 0) throw new Error("请至少填写一行有效的加油明细");
    const amount = items.reduce((s, it) => s + it.amount, 0);

    const customer = input.customerId
      ? data.value.customers.find((c) => c.id === input.customerId) ?? null
      : null;

    if (input.payMethod === "stored") {
      if (!customer) throw new Error("储值扣款必须选择客户");
      const bal = balanceOf(customer.id);
      if (bal < amount) {
        // 硬性约束：余额不足不能保存，必须改用现金或电子支付
        throw new Error(
          `储值余额不足：余额 ¥${centsToYuan(bal)}，订单 ¥${centsToYuan(amount)}，请改用现金或电子支付`
        );
      }
    }

    const seq = nextSeq("order");
    const order: Order = {
      id: uid("ord"),
      code: `O-${String(seq).padStart(4, "0")}`,
      shiftId: shift.id,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? "散客",
      items,
      amount,
      payMethod: input.payMethod,
      status: "settled",
      createdAt: nowIso()
    };
    data.value.orders.push(order);

    if (input.payMethod === "stored" && customer) {
      data.value.ledger.push({
        id: uid("led"),
        customerId: customer.id,
        kind: "sale",
        amount: -amount, // 整笔订单一次性扣款
        shiftId: shift.id,
        refCode: order.code,
        createdAt: order.createdAt
      });
    }
    persist();
    return order;
  }

  // ---------- 退款：只能引用已结算订单，不得超过原订单实付 ----------
  function createRefund(input: NewRefundInput): Refund {
    const shift = currentShift.value;
    if (!shift) throw new Error("当前没有进行中的班次，不能办理退款");

    const order = data.value.orders.find((o) => o.id === input.orderId);
    if (!order) throw new Error("退款必须引用已结算订单");
    if (order.status !== "settled") throw new Error("只能退款已结算订单");

    const amount = Math.round(input.amount);
    if (!(amount > 0)) throw new Error("退款金额必须大于 0");
    if (amount > order.amount) {
      throw new Error(
        `退款不得超过原订单实付金额 ¥${centsToYuan(order.amount)}`
      );
    }
    const left = remainingRefundable(order.id);
    if (amount > left) {
      throw new Error(
        `该订单累计可退余额仅剩 ¥${centsToYuan(left)}（实付 ¥${centsToYuan(order.amount)}，已退 ¥${centsToYuan(
          order.amount - left
        )}）`
      );
    }
    if (!input.reason.trim()) throw new Error("请填写退款原因");

    // 同一时刻只有一个开班：订单不属于当前班，则原班必然已交班冻结
    const crossShift = order.shiftId !== shift.id;

    const seq = nextSeq("refund");
    const refund: Refund = {
      id: uid("rf"),
      code: `R-${String(seq).padStart(4, "0")}`,
      shiftId: shift.id,
      orderId: order.id,
      orderCode: order.code,
      customerId: order.customerId,
      customerName: order.customerName,
      amount,
      payMethod: order.payMethod,
      reason: input.reason.trim(),
      crossShift,
      originShiftId: order.shiftId,
      balanceAfter: 0,
      createdAt: nowIso()
    };

    if (order.payMethod === "stored" && order.customerId) {
      data.value.ledger.push({
        id: uid("led"),
        customerId: order.customerId,
        kind: "refund",
        amount, // 补回余额
        shiftId: shift.id,
        refCode: refund.code,
        createdAt: refund.createdAt
      });
      refund.balanceAfter = balanceOf(order.customerId);
    }
    data.value.refunds.push(refund);

    // 跨班退款属于对已冻结原班订单的更正：自动登记一条带原因的冲正，
    // 旧值（原订单实付/已退）保留在冲正记录中，原班订单与快照不被改动。
    if (crossShift) {
      const origin = data.value.shifts.find((s) => s.id === order.shiftId);
      const alreadyRefunded = refundedAmount(order.id) - amount;
      const rseq = nextSeq("reversal");
      data.value.reversals.push({
        id: uid("rev"),
        code: `C-${String(rseq).padStart(4, "0")}`,
        shiftId: order.shiftId,
        originShiftCode: origin?.code ?? order.shiftId,
        originRef: order.code,
        kind: "refund",
        reason: `跨班退款 ${refund.code}：${input.reason.trim()}`,
        operator: input.operator.trim(),
        oldValue: `原订单实付 ¥${centsToYuan(order.amount)}；此前已退 ¥${centsToYuan(alreadyRefunded)}`,
        newValue: `本次退款 ¥${centsToYuan(amount)}（计入 ${shift.code}）；累计已退 ¥${centsToYuan(
          alreadyRefunded + amount
        )}`,
        currentShiftId: shift.id,
        createdAt: refund.createdAt
      });
    }
    persist();
    return refund;
  }

  /**
   * 跨班退款的账务说明：
   * - 现金/电子支付：当前班从本班收款中退付，并通过冲正记录关联原班；
   * - 储值：补回原班已扣余额（ledger refund 条目，记在当前班），
   *   原班 closingBalances 快照保持不变作为冻结证据。
   */

  // ---------- 冲正：冻结班次只能新增带原因的冲正，旧值保留 ----------
  function createReversal(input: NewReversalInput): Reversal {
    const shift = currentShift.value;
    if (!shift) throw new Error("当前没有进行中的班次，不能发起冲正");
    const origin = data.value.shifts.find((s) => s.id === input.originShiftId);
    if (!origin) throw new Error("原班次不存在");
    if (origin.closedAt === null) throw new Error("本班次未交班，可直接更正，无需冲正");
    if (!input.reason.trim()) throw new Error("冲正必须填写原因");
    if (!input.operator.trim()) throw new Error("请填写经办人");
    if (!input.oldValue.trim() || !input.newValue.trim()) throw new Error("请填写旧值与新值");

    const seq = nextSeq("reversal");
    const reversal: Reversal = {
      id: uid("rev"),
      code: `C-${String(seq).padStart(4, "0")}`,
      shiftId: origin.id,
      originShiftCode: origin.code,
      originRef: input.originRef.trim(),
      kind: input.kind,
      reason: input.reason.trim(),
      operator: input.operator.trim(),
      oldValue: input.oldValue.trim(),
      newValue: input.newValue.trim(),
      currentShiftId: shift.id,
      createdAt: nowIso()
    };
    data.value.reversals.push(reversal);
    persist();
    return reversal;
  }

  function resetAll() {
    data.value = seed();
    persist();
  }

  return {
    // state
    customers,
    shifts,
    orders,
    refunds,
    reversals,
    ledger,
    currentShift,
    balances,
    shiftSummaries,
    // helpers
    balanceOf,
    frozenBalance,
    paidAmount,
    refundedAmount,
    remainingRefundable,
    // actions
    addCustomer,
    recharge,
    openShift,
    closeShift,
    createOrder,
    createRefund,
    createReversal,
    resetAll
  };
});
