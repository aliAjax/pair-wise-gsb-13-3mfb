// 核心账务规则验证：用 esbuild 即时转译 store.ts，在 node 中驱动真实代码
import { build } from "esbuild";
import { createPinia, setActivePinia } from "pinia";
import { rmSync, writeFileSync } from "node:fs";

// ---- 浏览器环境桩 ----
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: () => Math.random().toString(36).slice(2) + Date.now().toString(36) },
  configurable: true
});

const result = await build({
  entryPoints: ["/workspace/src/store.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  external: ["pinia", "vue"]
});
writeFileSync("/workspace/.store-test-bundle.mjs", result.outputFiles[0].text);
const { useAccountStore, centsToYuan, yuanToCents } = await import("file:///workspace/.store-test-bundle.mjs");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}
function expectThrow(name, fn, fragment) {
  try {
    fn();
    check(name, false, "（未抛出异常）");
  } catch (e) {
    check(name, !fragment || String(e.message).includes(fragment), `实际：${e.message}`);
  }
}

function freshStore() {
  setActivePinia(createPinia());
  mem.clear();
  return useAccountStore();
}

const y = (n) => yuanToCents(n);

console.log("1) 种子数据：早班已冻结、中班进行中，余额=流水求和");
{
  const s = freshStore();
  check("存在进行中班", s.currentShift?.code === "SHIFT-002");
  check("张伟余额 200.00", s.balanceOf("cus-1") === 20000, centsToYuan(s.balanceOf("cus-1")));
  check("李娜余额 800.00", s.balanceOf("cus-2") === 80000);
  check("早班有冻结快照", s.frozenBalance("shift-1", "cus-1") === 20000);
}

console.log("2) 储值余额不足不能保存，必须改用现金/电子");
{
  const s = freshStore();
  const item = { fuelType: "92#", liters: 30, price: y(7.5) }; // 225 元 > 200
  expectThrow("余额不足的储值订单被拒绝", () =>
    s.createOrder({ customerId: "cus-1", items: [item], payMethod: "stored" }), "余额不足");
  check("余额未被扣动", s.balanceOf("cus-1") === 20000);
  const cash = s.createOrder({ customerId: null, items: [item], payMethod: "cash" });
  check("改用现金可以保存", cash.amount === 22500);
  const dig = s.createOrder({ customerId: null, items: [item], payMethod: "digital" });
  check("电子支付可以保存", dig.amount === 22500 && s.balanceOf("cus-1") === 20000);
}

console.log("3) 整笔订单一次性扣储值");
{
  const s = freshStore();
  const item = { fuelType: "92#", liters: 20, price: y(7.5) }; // 150
  const o = s.createOrder({ customerId: "cus-1", items: [item], payMethod: "stored" });
  check("订单已结算", o.status === "settled");
  check("余额整笔扣到 50.00", s.balanceOf("cus-1") === 5000, centsToYuan(s.balanceOf("cus-1")));
  check("只有一条扣款流水", s.ledger.filter((e) => e.customerId === "cus-1" && e.kind === "sale").length === 2); // 种子1条+新1条
}

console.log("4) 退款只能引用已结算订单且不得超过原实付/累计可退");
{
  const s = freshStore();
  expectThrow("无此订单不能退", () => s.createRefund({ orderId: "nope", amount: 1, reason: "x", operator: "a" }), "已结算订单");
  expectThrow("退款超过原实付被拒绝", () =>
    s.createRefund({ orderId: "ord-1", amount: 15001, reason: "x", operator: "a" }), "不得超过");
  const r1 = s.createRefund({ orderId: "ord-1", amount: 10000, reason: "部分退", operator: "王" });
  check("部分退款成功", r1.amount === 10000);
  expectThrow("累计超过实付被拒绝", () =>
    s.createRefund({ orderId: "ord-1", amount: 10000, reason: "再退", operator: "王" }), "可退余额仅剩");
  const r2 = s.createRefund({ orderId: "ord-1", amount: 5000, reason: "退清", operator: "王" });
  check("退满剩余成功", s.remainingRefundable("ord-1") === 0);
  expectThrow("退满后不能再退", () =>
    s.createRefund({ orderId: "ord-1", amount: 1, reason: "x", operator: "a" }), "可退余额仅剩");
  check("两笔退款均存在", r1.code !== r2.code && s.refunds.length === 2);
  expectThrow("退款必须填原因", () =>
    s.createRefund({ orderId: "ord-2", amount: 1, reason: "  ", operator: "a" }), "原因");
}

console.log("5) 跨班储值退款：补回原班余额、计入当前班、自动冲正、页面字段齐全");
{
  const s = freshStore();
  const before = s.balanceOf("cus-1"); // 20000
  const r = s.createRefund({ orderId: "ord-1", amount: 15000, reason: "跨班协商退款", operator: "李" });
  check("标记为跨班", r.crossShift === true);
  check("退款计入当前班 SHIFT-002", r.shiftId === "shift-2");
  check("原订单属于 SHIFT-001", r.originShiftId === "shift-1");
  check("客户=张伟", r.customerName === "张伟");
  check("原订单=O-0001", r.orderCode === "O-0001");
  check("退款额 150.00", r.amount === 15000);
  check("余额补回到 350.00", s.balanceOf("cus-1") === before + 15000);
  check("记录退款后余额", r.balanceAfter === 35000);
  const rev = s.reversals.find((x) => x.originRef === "O-0001");
  check("自动生成冲正", !!rev);
  check("冲正挂原班(冻结班)", rev?.shiftId === "shift-1");
  check("冲正由当前班发起", rev?.currentShiftId === "shift-2");
  check("冲正保留旧值", rev?.oldValue.includes("原订单实付"));
  check("冲正含原因", rev?.reason.includes("跨班协商退款"));
  check("原班冻结快照未被改动", s.frozenBalance("shift-1", "cus-1") === 20000);
}

console.log("6) 跨班现金退款：从当前班退付并登记冲正，不动储值");
{
  const s = freshStore();
  const b1 = s.balanceOf("cus-1");
  const r = s.createRefund({ orderId: "ord-2", amount: 24000, reason: "现金跨班退", operator: "赵" });
  check("现金跨班标记", r.crossShift === true && r.payMethod === "cash");
  check("储值余额不变", s.balanceOf("cus-1") === b1);
  const summary = s.shiftSummaries.find((x) => x.shift.id === "shift-2");
  check("当前班退款支出 240.00", summary.refundOut === 24000);
  check("现金冲正已登记", s.reversals.some((x) => x.originRef === "O-0002"));
}

console.log("7) 交班冻结：订单/余额冻结，更正只能新增带原因冲正");
{
  const s = freshStore();
  expectThrow("未交班的班次不能冲正（当前班未冻结）", () =>
    s.createReversal({ originShiftId: "shift-2", originRef: "X", kind: "correction", reason: "r", operator: "a", oldValue: "1", newValue: "2" }), "无需冲正");
  s.closeShift("账实一致");
  check("交班后无进行中班", s.currentShift === null);
  expectThrow("冻结后不能再录订单", () =>
    s.createOrder({ customerId: "cus-1", items: [{ fuelType: "92#", liters: 1, price: y(7) }], payMethod: "stored" }), "进行中");
  expectThrow("不能开班状态下充值", () => s.recharge("cus-1", 100), "进行中");
  // 重新开班后才能对冻结班冲正
  s.openShift("晚班");
  expectThrow("冲正必须有原因", () =>
    s.createReversal({ originShiftId: "shift-1", originRef: "O-0001", kind: "correction", reason: "", operator: "a", oldValue: "1", newValue: "2" }), "原因");
  const rev = s.createReversal({
    originShiftId: "shift-1", originRef: "O-0001", kind: "correction",
    reason: "录入差错更正", operator: "钱", oldValue: "150.00", newValue: "140.00"
  });
  check("冲正新增成功", rev.code.startsWith("C-") && s.reversals.length === 1);
  const o = s.orders.find((x) => x.id === "ord-1");
  check("旧订单原值保持不变（旧值保留）", o.amount === 15000);
  check("原班快照依旧冻结", s.frozenBalance("shift-1", "cus-1") === 20000);
}

console.log("8) 刷新后账务一致：重新从 localStorage 载入，余额与流水重算一致");
{
  const s = freshStore();
  s.createRefund({ orderId: "ord-3", amount: 10000, reason: "退", operator: "a" }); // 李娜 80000+10000
  s.createOrder({ customerId: "cus-1", items: [{ fuelType: "92#", liters: 10, price: y(7.5) }], payMethod: "stored" }); // 20000-7500
  const snapshot = {
    cus1: s.balanceOf("cus-1"),
    cus2: s.balanceOf("cus-2"),
    refunds: s.refunds.length,
    reversals: s.reversals.length,
    orders: s.orders.length
  };
  setActivePinia(createPinia()); // 模拟刷新：重新建 store，从 localStorage 读
  const s2 = useAccountStore();
  check("张伟余额刷新一致", s2.balanceOf("cus-1") === snapshot.cus1);
  check("李娜余额刷新一致", s2.balanceOf("cus-2") === snapshot.cus2);
  check("退款单数刷新一致", s2.refunds.length === snapshot.refunds);
  check("冲正数刷新一致（含1条跨班自动冲正）", s2.reversals.length === snapshot.reversals && snapshot.reversals === 1);
  check("订单数刷新一致", s2.orders.length === snapshot.orders);
  // 余额恒等式：所有流水之和 = 全部客户余额之和
  const ledgerSum = s2.ledger.reduce((a, e) => a + e.amount, 0);
  const balSum = s2.customers.reduce((a, c) => a + s2.balanceOf(c.id), 0);
  check("流水合计 == 余额合计", ledgerSum === balSum, `${ledgerSum} vs ${balSum}`);
}

console.log("9) 同一时刻只能有一个开班");
{
  const s = freshStore();
  expectThrow("重复开班被拒绝", () => s.openShift("晚班"), "先交班");
}

rmSync("/workspace/.store-test-bundle.mjs");
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
