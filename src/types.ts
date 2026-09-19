// 金额一律以「分」为单位存储为整数，避免浮点误差，展示时再转为元

export type PayMethod = "stored" | "cash" | "digital";
export type LedgerKind = "recharge" | "sale" | "refund";

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string;
  createdAt: string;
}

export interface Shift {
  id: string;
  code: string; // 班次编号，如 SHIFT-001
  name: string; // 早班 / 中班 / 晚班
  openedAt: string;
  closedAt: string | null;
  /** 交班快照：冻结时每个储值客户的余额（分），key 为 customerId */
  closingBalances: Record<string, number>;
  /** 交班备注（如账实一致说明） */
  closeNote: string;
}

export interface OrderItem {
  fuelType: string; // 油品，如 92#
  liters: number; // 升数，保留 2 位小数
  price: number; // 单价（分/升）
  amount: number; // 小计金额（分）
}

export interface Order {
  id: string;
  code: string; // 订单号，如 O-20260919-001
  shiftId: string;
  customerId: string | null; // 现金/电子支付可为空
  customerName: string; // 冗余快照，客户改名不影响旧账
  items: OrderItem[];
  amount: number; // 订单实付总额（分），整笔一次性结清
  payMethod: PayMethod;
  status: "settled"; // 保存即结算，不允许挂账
  createdAt: string;
}

export interface Refund {
  id: string;
  code: string; // 退款单号，如 R-0001
  shiftId: string; // 实际处理退款的班次（当前班）
  orderId: string;
  orderCode: string; // 冗余快照
  customerId: string | null;
  customerName: string;
  amount: number; // 本次退款金额（分）
  payMethod: PayMethod; // 沿用原订单支付方式
  reason: string;
  crossShift: boolean; // 是否跨班退款
  originShiftId: string; // 原订单所在班次
  balanceAfter: number; // 退款后该客户储值余额（分）；非储值为 0
  createdAt: string;
}

/** 冲正（更正）记录：冻结班次的任何更正都只能新增，旧值保留 */
export interface Reversal {
  id: string;
  code: string; // 冲正单号，如 C-0001
  shiftId: string; // 被更正的班次（已冻结的原班）
  originShiftCode: string;
  originRef: string; // 被更正对象，如订单号 / 退款单号
  kind: "refund" | "correction";
  reason: string; // 必填原因
  operator: string;
  oldValue: string; // 旧值（冻结值）
  newValue: string; // 更正后值
  currentShiftId: string; // 由哪个当前班发起
  createdAt: string;
}

/** 储值分户流水：客户余额 = 该客户所有 entry 金额之和（分） */
export interface LedgerEntry {
  id: string;
  customerId: string;
  kind: LedgerKind;
  amount: number; // 充值为正，扣款为负，退款为正（分）
  shiftId: string;
  refCode: string; // 关联订单号 / 退款单号 / 充值单号
  createdAt: string;
}

export interface PersistShape {
  version: number;
  customers: Customer[];
  shifts: Shift[];
  orders: Order[];
  refunds: Refund[];
  reversals: Reversal[];
  ledger: LedgerEntry[];
  seq: Record<string, number>;
}
