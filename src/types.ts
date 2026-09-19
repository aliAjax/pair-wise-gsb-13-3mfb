// 储值账户结算台领域模型
// 设计原则：订单/班次只增不改，一切变动以追加流水（ledger / refund / correction）表达；
// 客户储值余额由流水实时推导，保证刷新后账务一致。

export type PayMethod = "stored" | "cash" | "digital";

export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  stored: "储值扣款",
  cash: "现金",
  digital: "电子支付"
};

export interface Customer {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
}

export interface Shift {
  id: string;
  code: string; // 例：2026-09-19 早班
  openedAt: string;
  closedAt: string | null;
  openingCash: number; // 开班备用金
}

export interface Order {
  id: string;
  code: string; // 订单号
  shiftId: string;
  customerId: string | null; // 散客为 null
  fuelType: string;
  liters: number;
  unitPrice: number;
  amount: number; // 应付（实付）
  method: PayMethod; // 整笔订单单一支付方式
  balanceAfter: number | null; // 储值支付后的客户余额快照
  createdAt: string;
}

export interface Refund {
  id: string;
  code: string;
  orderId: string; // 只能引用已结算订单
  shiftId: string; // 受理退款的班次（当前开班）
  amount: number; // 不得超过原订单实付 - 已退
  reason: string;
  crossShift: boolean; // 是否跨班退款
  correctionId: string | null; // 跨班时生成的冲正记录
  balanceAfter: number | null; // 储值退款补回后的客户余额
  createdAt: string;
}

export interface Correction {
  id: string;
  code: string;
  shiftId: string; // 归属原班（冻结后唯一允许新增的记录类型）
  orderId: string;
  refundId: string;
  kind: PayMethod | "stored";
  reason: string;
  amount: number; // 冲正金额（原班该笔订单已被退的部分，本次新增）
  oldValue: {
    orderAmount: number; // 原订单实付
    shiftSalesBefore: number; // 该支付方式原班累计销售额（冲正前）
    shiftRefundedBefore: number; // 原班已冲正金额（本次之前）
    shiftNetAfter: number; // 冲正后净额
    customerBalanceBefore: number | null;
  };
  createdAt: string;
}

export type LedgerKind =
  | "topup" // 储值充值（客户余额 +）
  | "sale" // 储值消费扣款（客户余额 -）
  | "refund_credit"; // 退款补回（客户余额 +，跨班时挂原班冲正）

export interface LedgerEntry {
  id: string;
  shiftId: string; // 储值资金归属班次；跨班退款补回时为原班
  customerId: string;
  kind: LedgerKind;
  amount: number;
  orderId: string | null;
  refundId: string | null;
  correctionId: string | null;
  balanceAfter: number;
  createdAt: string;
}

export interface DB {
  version: number;
  customers: Customer[];
  shifts: Shift[];
  orders: Order[];
  refunds: Refund[];
  corrections: Correction[];
  ledger: LedgerEntry[];
}
