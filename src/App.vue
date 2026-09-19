<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { centsToYuan, yuanToCents, useAccountStore } from "./store";
import type { PayMethod } from "./types";

const store = useAccountStore();

const PAY_LABEL: Record<PayMethod, string> = {
  stored: "储值扣款",
  cash: "现金",
  digital: "电子支付"
};
const PAY_TAG: Record<PayMethod, "" | "success" | "warning" | "info"> = {
  stored: "success",
  cash: "warning",
  digital: "info"
};
const FUELS = ["92#", "95#", "98#", "0#"];

// ---------------- 订单录入 ----------------
interface ItemRow {
  fuelType: string;
  liters: number | null;
  price: number | null;
}

const orderForm = reactive<{
  customerId: string | null;
  payMethod: PayMethod;
  items: ItemRow[];
}>({
  customerId: null,
  payMethod: "stored",
  items: [{ fuelType: "92#", liters: null, price: null }]
});

function resetOrderForm() {
  orderForm.customerId = null;
  orderForm.payMethod = "stored";
  orderForm.items = [{ fuelType: "92#", liters: null, price: null }];
}

function addItemRow() {
  orderForm.items.push({ fuelType: "92#", liters: null, price: null });
}
function removeItemRow(index: number) {
  if (orderForm.items.length === 1) return;
  orderForm.items.splice(index, 1);
}

function rowAmount(row: ItemRow): number {
  const l = Number(row.liters);
  const p = Number(row.price); // 表单录入单位：元/升
  if (!Number.isFinite(l) || l <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  return Math.round(l * yuanToCents(p)); // 统一转为分
}

const orderTotal = computed(() => orderForm.items.reduce((s, r) => s + rowAmount(r), 0));
const selectedBalance = computed(() =>
  orderForm.customerId ? store.balanceOf(orderForm.customerId) : 0
);
const insufficient = computed(
  () => orderForm.payMethod === "stored" && orderTotal.value > selectedBalance.value
);
const validRows = computed(() =>
  orderForm.items.every((r) => Number(r.liters) > 0 && Number(r.price) > 0)
);
const canSaveOrder = computed(
  () => store.currentShift !== null && validRows.value && orderTotal.value > 0 && !insufficient.value
);

function saveOrder() {
  try {
    const order = store.createOrder({
      customerId: orderForm.customerId,
      payMethod: orderForm.payMethod,
      items: orderForm.items
        .filter((r) => Number(r.liters) > 0 && Number(r.price) > 0)
        .map((r) => ({ fuelType: r.fuelType, liters: Number(r.liters), price: yuanToCents(r.price) }))
    });
    ElMessage.success(`订单 ${order.code} 已结算，整笔扣款 ¥${centsToYuan(order.amount)}`);
    resetOrderForm();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- 客户 / 充值 ----------------
const customerForm = reactive({ code: "", name: "", phone: "" });
const rechargeTarget = ref<string | null>(null);
const rechargeAmount = ref<number | null>(null);

function saveCustomer() {
  if (!customerForm.name.trim()) {
    ElMessage.error("请填写客户姓名");
    return;
  }
  if (!customerForm.code.trim()) customerForm.code = `VIP${String(store.customers.length + 1).padStart(3, "0")}`;
  store.addCustomer(customerForm);
  ElMessage.success(`客户 ${customerForm.name} 已开户`);
  customerForm.code = "";
  customerForm.name = "";
  customerForm.phone = "";
}

function doRecharge() {
  if (!rechargeTarget.value) return ElMessage.error("请选择充值客户");
  const cents = yuanToCents(rechargeAmount.value ?? 0);
  if (!(cents > 0)) return ElMessage.error("充值金额必须大于 0");
  try {
    store.recharge(rechargeTarget.value, cents);
    ElMessage.success(`充值成功 ¥${centsToYuan(cents)}`);
    rechargeAmount.value = null;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- 退款 ----------------
const refundForm = reactive({
  orderId: "",
  amount: null as number | null,
  reason: "",
  operator: ""
});

const refundableOrders = computed(() =>
  [...store.orders]
    .reverse()
    .filter((o) => store.remainingRefundable(o.id) > 0)
);

const selectedOrder = computed(() =>
  refundForm.orderId ? store.orders.find((o) => o.id === refundForm.orderId) ?? null : null
);
const refundCrossShift = computed(() => {
  const o = selectedOrder.value;
  return !!o && !!store.currentShift && o.shiftId !== store.currentShift.id;
});
const refundAmountCents = computed(() => yuanToCents(refundForm.amount ?? 0));
const refundOver = computed(() => {
  const o = selectedOrder.value;
  if (!o || !(refundAmountCents.value > 0)) return false;
  return refundAmountCents.value > store.remainingRefundable(o.id);
});

function orderShiftName(shiftId: string) {
  return store.shifts.find((s) => s.id === shiftId)?.code ?? shiftId;
}

function submitRefund() {
  if (!refundForm.orderId) return ElMessage.error("请选择要退款的已结算订单");
  if (!(refundAmountCents.value > 0)) return ElMessage.error("退款金额必须大于 0");
  if (refundOver.value) return ElMessage.error("退款不得超过原订单实付金额（扣已退）");
  if (!refundForm.reason.trim()) return ElMessage.error("请填写退款原因");
  if (!refundForm.operator.trim()) return ElMessage.error("请填写经办人");
  try {
    const r = store.createRefund({
      orderId: refundForm.orderId,
      amount: refundAmountCents.value,
      reason: refundForm.reason,
      operator: refundForm.operator
    });
    ElMessage.success(
      `${r.code} 已完成${r.crossShift ? "（跨班，已补回原班余额并登记冲正）" : ""}`
    );
    refundForm.orderId = "";
    refundForm.amount = null;
    refundForm.reason = "";
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- 冲正 ----------------
const reversalForm = reactive({
  originShiftId: "",
  originRef: "",
  kind: "correction" as "refund" | "correction",
  reason: "",
  operator: "",
  oldValue: "",
  newValue: ""
});
const frozenShifts = computed(() => store.shifts.filter((s) => s.closedAt !== null));

function submitReversal() {
  try {
    const r = store.createReversal({ ...reversalForm });
    ElMessage.success(`冲正 ${r.code} 已登记，原值保留可查`);
    reversalForm.originRef = "";
    reversalForm.reason = "";
    reversalForm.oldValue = "";
    reversalForm.newValue = "";
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- 班次 ----------------
const newShiftName = ref("");
async function openShift() {
  try {
    store.openShift(newShiftName.value || "当班");
    ElMessage.success("已开班");
    newShiftName.value = "";
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function closeShift() {
  try {
    const { value } = await ElMessageBox.prompt("交班后本班订单与储值余额将冻结，请填写交班备注", "确认交班", {
      confirmButtonText: "确认交班",
      cancelButtonText: "取消",
      inputPlaceholder: "如：账实一致",
      inputValue: "账实一致"
    });
    store.closeShift(value);
    ElMessage.success("已交班，订单与余额已冻结并生成快照");
  } catch (e) {
    if (e !== "cancel" && (e as Error)?.message) ElMessage.error((e as Error).message);
  }
}

async function resetDemo() {
  try {
    await ElMessageBox.confirm("将清空当前全部数据并恢复演示数据，确定吗？", "重置演示数据", {
      type: "warning"
    });
    store.resetAll();
    ElMessage.success("已恢复演示数据");
  } catch {
    /* 用户取消 */
  }
}

// ---------------- 列表展示辅助 ----------------
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
function orderItemsText(items: { fuelType: string; liters: number; price: number; amount: number }[]) {
  return items.map((i) => `${i.fuelType} ${i.liters}L×¥${centsToYuan(i.price)}`).join("；");
}
function currentBalance(customerId: string | null) {
  return customerId ? store.balanceOf(customerId) : null;
}
function balanceYuan(customerId: string | null) {
  const v = currentBalance(customerId);
  return v === null ? "—" : `¥${centsToYuan(v)}`;
}

// ---------------- 订单搜索 ----------------
const orderFilter = ref("");
const filteredOrders = computed(() =>
  [...store.orders]
    .reverse()
    .filter((o) => !orderFilter.value || `${o.code}${o.customerName}`.includes(orderFilter.value))
);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">储值账户结算台 · 加油整笔扣款</p>
          <h1>加油站储值结算与班次交接</h1>
          <p class="subtitle">
            订单整笔结算、余额不足禁止保存；退款只引用已结算订单且不超原付；交班即冻结，更正只追加带原因冲正；跨班退款补回原班余额并计入当前班。
          </p>
        </div>
        <div class="shift-box" :class="{ open: store.currentShift }">
          <template v-if="store.currentShift">
            <span class="shift-label">当前班</span>
            <strong>{{ store.currentShift.code }} · {{ store.currentShift.name }}</strong>
            <span class="shift-time">开班 {{ fmtTime(store.currentShift.openedAt) }}</span>
            <el-button type="primary" size="small" @click="closeShift">交班冻结</el-button>
          </template>
          <template v-else>
            <span class="shift-label">无进行中班次</span>
            <el-input v-model="newShiftName" placeholder="班次名，如 晚班" size="small" />
            <el-button type="primary" size="small" @click="openShift">开班</el-button>
          </template>
          <el-button size="small" plain @click="resetDemo">重置演示</el-button>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>储值客户</span>
          <strong>{{ store.customers.length }}</strong>
        </article>
        <article class="metric">
          <span>储值总余额（元）</span>
          <strong>¥{{ centsToYuan(store.customers.reduce((s, c) => s + store.balanceOf(c.id), 0)) }}</strong>
        </article>
        <article class="metric">
          <span>已结算订单 / 退款单</span>
          <strong>{{ store.orders.length }} / {{ store.refunds.length }}</strong>
        </article>
        <article class="metric">
          <span>冻结班次 / 冲正记录</span>
          <strong>{{ frozenShifts.length }} / {{ store.reversals.length }}</strong>
        </article>
      </section>

      <el-tabs class="tabs">
        <!-- ============ 收银 ============ -->
        <el-tab-pane label="收银结算" name="order">
          <div class="two-col">
            <el-card class="panel" shadow="never">
              <template #header>
                <div class="card-head">
                  <h2>加油订单</h2>
                  <el-tag v-if="!store.currentShift" type="danger">未开班，不能保存</el-tag>
                </div>
              </template>

              <el-form label-position="top">
                <el-form-item label="客户（散客可留空）">
                  <el-select v-model="orderForm.customerId" clearable placeholder="选择储值客户 / 散客" style="width: 100%">
                    <el-option label="散客（非储值）" :value="null" />
                    <el-option
                      v-for="c in store.customers"
                      :key="c.id"
                      :label="`${c.name}（${c.code}）余额 ¥${centsToYuan(store.balanceOf(c.id))}`"
                      :value="c.id"
                    />
                  </el-select>
                </el-form-item>

                <el-form-item label="支付方式">
                  <el-radio-group v-model="orderForm.payMethod">
                    <el-radio-button value="stored">储值扣款</el-radio-button>
                    <el-radio-button value="cash">现金</el-radio-button>
                    <el-radio-button value="digital">电子支付</el-radio-button>
                  </el-radio-group>
                </el-form-item>

                <div v-for="(row, idx) in orderForm.items" :key="idx" class="fuel-row">
                  <el-select v-model="row.fuelType" style="width: 96px">
                    <el-option v-for="f in FUELS" :key="f" :label="f" :value="f" />
                  </el-select>
                  <el-input-number v-model="row.liters" :min="0" :precision="2" :step="10" placeholder="升数" controls-position="right" />
                  <el-input-number v-model="row.price" :min="0" :precision="2" :step="0.1" placeholder="单价元/升" controls-position="right" />
                  <span class="row-amount">¥{{ centsToYuan(rowAmount(row)) }}</span>
                  <el-button link type="danger" :disabled="orderForm.items.length === 1" @click="removeItemRow(idx)">删</el-button>
                </div>
                <el-button link type="primary" @click="addItemRow">+ 添加油品行</el-button>

                <div class="total-line">
                  <span>整笔应付</span>
                  <strong>¥{{ centsToYuan(orderTotal) }}</strong>
                </div>
                <div v-if="orderForm.payMethod === 'stored'" class="balance-line" :class="{ bad: insufficient }">
                  储值余额：¥{{ centsToYuan(selectedBalance) }}
                  <span v-if="orderForm.customerId === null" class="warn">储值扣款必须选择客户</span>
                  <span v-else-if="insufficient" class="warn">
                    余额不足，不能保存 —— 请改用现金或电子支付（差额 ¥{{ centsToYuan(orderTotal - selectedBalance) }}）
                  </span>
                  <span v-else class="ok">可整笔扣清</span>
                </div>

                <el-button type="primary" class="full" :disabled="!canSaveOrder" @click="saveOrder">
                  保存并整笔结算
                </el-button>
              </el-form>
            </el-card>

            <el-card class="panel" shadow="never">
              <template #header><h2>储值客户与充值</h2></template>
              <div class="recharge-row">
                <el-select v-model="rechargeTarget" placeholder="选择客户" style="flex: 1">
                  <el-option
                    v-for="c in store.customers"
                    :key="c.id"
                    :label="`${c.name}（${c.code}）`"
                    :value="c.id"
                  />
                </el-select>
                <el-input-number v-model="rechargeAmount" :min="0" :precision="2" :step="100" placeholder="充值元" controls-position="right" />
                <el-button type="primary" @click="doRecharge">充值</el-button>
              </div>

              <el-divider />
              <el-table :data="store.customers" size="small">
                <el-table-column label="客户" min-width="120">
                  <template #default="{ row }">{{ row.name }} <span class="muted">{{ row.code }}</span></template>
                </el-table-column>
                <el-table-column prop="phone" label="电话" min-width="120" />
                <el-table-column label="当前余额（元）" width="130" align="right">
                  <template #default="{ row }">
                    <strong>¥{{ centsToYuan(store.balanceOf(row.id)) }}</strong>
                  </template>
                </el-table-column>
              </el-table>

              <el-divider />
              <div class="new-customer">
                <el-input v-model="customerForm.code" placeholder="客户编号（可自动生成）" />
                <el-input v-model="customerForm.name" placeholder="姓名 *" />
                <el-input v-model="customerForm.phone" placeholder="手机号" />
                <el-button @click="saveCustomer">开户</el-button>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- ============ 退款 ============ -->
        <el-tab-pane label="退款办理" name="refund">
          <div class="two-col">
            <el-card class="panel" shadow="never">
              <template #header>
                <div class="card-head">
                  <h2>发起退款</h2>
                  <el-tag v-if="!store.currentShift" type="danger">未开班</el-tag>
                </div>
              </template>
              <el-form label-position="top">
                <el-form-item label="选择已结算订单（仅列可退余额 &gt; 0）">
                  <el-select v-model="refundForm.orderId" filterable placeholder="按订单号选择" style="width: 100%">
                    <el-option
                      v-for="o in refundableOrders"
                      :key="o.id"
                      :label="`${o.code} · ${o.customerName} · 实付¥${centsToYuan(o.amount)} · ${PAY_LABEL[o.payMethod]} · ${orderShiftName(o.shiftId)}`"
                      :value="o.id"
                    />
                  </el-select>
                </el-form-item>

                <template v-if="selectedOrder">
                  <el-descriptions :column="2" border size="small" class="desc">
                    <el-descriptions-item label="原订单">{{ selectedOrder.code }}</el-descriptions-item>
                    <el-descriptions-item label="客户">{{ selectedOrder.customerName }}</el-descriptions-item>
                    <el-descriptions-item label="原实付金额">¥{{ centsToYuan(selectedOrder.amount) }}</el-descriptions-item>
                    <el-descriptions-item label="已退 / 可退">
                      ¥{{ centsToYuan(store.refundedAmount(selectedOrder.id)) }} /
                      <strong>¥{{ centsToYuan(store.remainingRefundable(selectedOrder.id)) }}</strong>
                    </el-descriptions-item>
                    <el-descriptions-item label="支付方式">{{ PAY_LABEL[selectedOrder.payMethod] }}</el-descriptions-item>
                    <el-descriptions-item label="所属班次">
                      {{ orderShiftName(selectedOrder.shiftId) }}
                      <el-tag v-if="refundCrossShift" type="warning" size="small">跨班退款</el-tag>
                    </el-descriptions-item>
                  </el-descriptions>

                  <el-form-item label="退款金额（元）" class="mt">
                    <el-input-number v-model="refundForm.amount" :min="0" :max="store.remainingRefundable(selectedOrder.id) / 100"
                      :precision="2" :step="10" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <div v-if="refundOver" class="warn">退款不得超过原订单实付金额（扣减累计已退）</div>

                  <el-form-item label="退款原因（必填，随冲正留档）">
                    <el-input v-model="refundForm.reason" type="textarea" :rows="2" placeholder="如：加油后车辆故障，协商退付" />
                  </el-form-item>
                  <el-form-item label="经办人">
                    <el-input v-model="refundForm.operator" placeholder="当前班经办人" />
                  </el-form-item>

                  <el-alert
                    v-if="refundCrossShift"
                    type="warning"
                    :closable="false"
                    show-icon
                    title="该订单属于已交班冻结的原班"
                    description="储值订单：退款先补回原班客户余额，再计入当前班流水，并自动生成带原因的冲正记录；现金/电子支付：从当前班款项退付，同样登记冲正，原班订单与冻结快照保持不变。"
                    class="mt"
                  />

                  <el-button type="primary" class="full mt" @click="submitRefund">确认退款</el-button>
                </template>
                <el-empty v-else description="请选择一笔已结算订单" :image-size="60" />
              </el-form>
            </el-card>

            <el-card class="panel" shadow="never">
              <template #header><h2>退款记录（客户 / 原订单 / 退款额 / 余额）</h2></template>
              <el-table :data="[...store.refunds].reverse()" size="small">
                <el-table-column label="退款单" min-width="90" prop="code" />
                <el-table-column label="客户" min-width="90" prop="customerName" />
                <el-table-column label="原订单" min-width="90" prop="orderCode" />
                <el-table-column label="退款额（元）" width="105" align="right">
                  <template #default="{ row }">¥{{ centsToYuan(row.amount) }}</template>
                </el-table-column>
                <el-table-column label="退款后余额（元）" width="125" align="right">
                  <template #default="{ row }">
                    <span v-if="row.payMethod === 'stored'">¥{{ centsToYuan(row.balanceAfter) }}</span>
                    <span v-else class="muted">—</span>
                  </template>
                </el-table-column>
                <el-table-column label="方式" width="90">
                  <template #default="{ row }">
                    <el-tag size="small" :type="PAY_TAG[row.payMethod as PayMethod]">{{ PAY_LABEL[row.payMethod as PayMethod] }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="班次" min-width="120">
                  <template #default="{ row }">
                    {{ orderShiftName(row.shiftId) }}
                    <el-tag v-if="row.crossShift" size="small" type="warning">跨班</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="原因" min-width="150" prop="reason" show-overflow-tooltip />
                <el-table-column label="时间" width="160">
                  <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
                </el-table-column>
              </el-table>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- ============ 账务流水 ============ -->
        <el-tab-pane label="账务流水" name="ledger">
          <el-card class="panel" shadow="never">
            <template #header>
              <div class="card-head">
                <h2>储值分户流水（余额 = 充值 − 扣款 + 退款，刷新后一致）</h2>
                <span class="muted">数据落盘 localStorage</span>
              </div>
            </template>
            <el-table :data="[...store.ledger].reverse()" size="small">
              <el-table-column label="时间" width="160">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="客户" min-width="100">
                <template #default="{ row }">
                  {{ store.customers.find((c) => c.id === row.customerId)?.name ?? row.customerId }}
                </template>
              </el-table-column>
              <el-table-column label="类型" width="90">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.kind === 'recharge' ? 'success' : row.kind === 'refund' ? 'warning' : 'danger'">
                    {{ row.kind === "recharge" ? "充值" : row.kind === "sale" ? "加油扣款" : "退款补回" }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="发生额（元）" width="120" align="right">
                <template #default="{ row }">
                  <span :class="row.amount >= 0 ? 'pos' : 'neg'">
                    {{ row.amount >= 0 ? "+" : "" }}¥{{ centsToYuan(row.amount) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="关联单号" min-width="110" prop="refCode" />
              <el-table-column label="所在班" min-width="100">
                <template #default="{ row }">{{ orderShiftName(row.shiftId) }}</template>
              </el-table-column>
              <el-table-column label="该客户当前余额（元）" width="150" align="right">
                <template #default="{ row }">¥{{ centsToYuan(store.balanceOf(row.customerId)) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-tab-pane>

        <!-- ============ 班次与冲正 ============ -->
        <el-tab-pane label="班次交接 / 冲正" name="shift">
          <div class="two-col">
            <el-card class="panel" shadow="never">
              <template #header><h2>班次台账（交班后冻结）</h2></template>
              <el-timeline>
                <el-timeline-item
                  v-for="s in [...store.shiftSummaries].reverse()"
                  :key="s.shift.id"
                  :type="s.shift.closedAt ? 'info' : 'primary'"
                  :hollow="!s.shift.closedAt"
                >
                  <div class="shift-card">
                    <div class="shift-card-head">
                      <strong>{{ s.shift.code }} · {{ s.shift.name }}</strong>
                      <el-tag size="small" :type="s.shift.closedAt ? 'info' : 'success'">
                        {{ s.shift.closedAt ? "已冻结" : "进行中" }}
                      </el-tag>
                    </div>
                    <p class="muted">
                      开班 {{ fmtTime(s.shift.openedAt) }}<br />
                      {{ s.shift.closedAt ? `交班 ${fmtTime(s.shift.closedAt)} · ${s.shift.closeNote || "—"}` : "尚未交班" }}
                    </p>
                    <el-descriptions :column="2" size="small" border>
                      <el-descriptions-item label="订单数">{{ s.orderCount }}</el-descriptions-item>
                      <el-descriptions-item label="退款数">{{ s.refundCount }}</el-descriptions-item>
                      <el-descriptions-item label="现金收入">¥{{ centsToYuan(s.cash) }}</el-descriptions-item>
                      <el-descriptions-item label="电子支付">¥{{ centsToYuan(s.digital) }}</el-descriptions-item>
                      <el-descriptions-item label="储值扣款">¥{{ centsToYuan(s.stored) }}</el-descriptions-item>
                      <el-descriptions-item label="现金/电子退款支出">¥{{ centsToYuan(s.refundOut) }}</el-descriptions-item>
                      <el-descriptions-item label="储值退款补回">¥{{ centsToYuan(s.storedRefund) }}</el-descriptions-item>
                      <el-descriptions-item label="本班充值">¥{{ centsToYuan(s.recharge) }}</el-descriptions-item>
                    </el-descriptions>
                    <details v-if="s.shift.closedAt" class="snapshot">
                      <summary>交班冻结余额快照</summary>
                      <p v-for="c in store.customers" :key="c.id">
                        {{ c.name }}：¥{{ centsToYuan(s.shift.closingBalances[c.id] ?? 0) }}
                      </p>
                    </details>
                  </div>
                </el-timeline-item>
              </el-timeline>
            </el-card>

            <div class="stack-col">
              <el-card class="panel" shadow="never">
                <template #header><h2>新增冲正（更正冻结班次，只追加不改旧值）</h2></template>
                <el-form label-position="top">
                  <el-form-item label="原班次（必须已交班）">
                    <el-select v-model="reversalForm.originShiftId" placeholder="选择冻结班次" style="width: 100%">
                      <el-option v-for="s in frozenShifts" :key="s.id" :label="`${s.code} · ${s.name}`" :value="s.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="关联单号（订单/退款单）">
                    <el-input v-model="reversalForm.originRef" placeholder="如 O-0001" />
                  </el-form-item>
                  <el-form-item label="类型">
                    <el-radio-group v-model="reversalForm.kind">
                      <el-radio value="correction">账务更正</el-radio>
                      <el-radio value="refund">退款更正</el-radio>
                    </el-radio-group>
                  </el-form-item>
                  <el-form-item label="旧值（保留）">
                    <el-input v-model="reversalForm.oldValue" type="textarea" :rows="2" placeholder="冻结时的原始值" />
                  </el-form-item>
                  <el-form-item label="新值">
                    <el-input v-model="reversalForm.newValue" type="textarea" :rows="2" placeholder="更正后的值" />
                  </el-form-item>
                  <el-form-item label="原因（必填）">
                    <el-input v-model="reversalForm.reason" type="textarea" :rows="2" />
                  </el-form-item>
                  <el-form-item label="经办人">
                    <el-input v-model="reversalForm.operator" />
                  </el-form-item>
                  <el-button type="primary" class="full" @click="submitReversal">登记冲正</el-button>
                </el-form>
              </el-card>
            </div>
          </div>

          <el-card class="panel mt" shadow="never">
            <template #header><h2>冲正记录（旧值留痕，跨班退款自动在此登记）</h2></template>
            <el-table :data="[...store.reversals].reverse()" size="small">
              <el-table-column prop="code" label="冲正单" width="90" />
              <el-table-column label="原班次" width="110">
                <template #default="{ row }">
                  {{ row.originShiftCode }}
                  <el-tag size="small" type="warning" class="ml4">冻结</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="originRef" label="关联单号" width="100" />
              <el-table-column label="类型" width="90">
                <template #default="{ row }">{{ row.kind === "refund" ? "退款更正" : "账务更正" }}</template>
              </el-table-column>
              <el-table-column label="旧值（保留）" min-width="180">
                <template #default="{ row }"><span class="old-val">{{ row.oldValue }}</span></template>
              </el-table-column>
              <el-table-column label="新值" min-width="180">
                <template #default="{ row }"><span class="new-val">{{ row.newValue }}</span></template>
              </el-table-column>
              <el-table-column prop="reason" label="原因" min-width="160" show-overflow-tooltip />
              <el-table-column prop="operator" label="经办人" width="90" />
              <el-table-column label="发起班" width="100">
                <template #default="{ row }">{{ orderShiftName(row.currentShiftId) }}</template>
              </el-table-column>
              <el-table-column label="时间" width="160">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-tab-pane>

        <!-- ============ 订单明细 ============ -->
        <el-tab-pane label="已结算订单" name="orders">
          <el-card class="panel" shadow="never">
            <template #header>
              <div class="card-head">
                <h2>订单明细（保存即结算，冻结班订单不可改）</h2>
                <el-input v-model="orderFilter" placeholder="搜索订单号/客户" clearable style="width: 220px" />
              </div>
            </template>
            <el-table :data="filteredOrders" size="small">
              <el-table-column prop="code" label="订单号" width="100" />
              <el-table-column label="客户" min-width="100" prop="customerName" />
              <el-table-column label="油品明细" min-width="220">
                <template #default="{ row }">{{ orderItemsText(row.items) }}</template>
              </el-table-column>
              <el-table-column label="实付（元）" width="105" align="right">
                <template #default="{ row }"><strong>¥{{ centsToYuan(row.amount) }}</strong></template>
              </el-table-column>
              <el-table-column label="支付方式" width="105">
                <template #default="{ row }">
                  <el-tag size="small" :type="PAY_TAG[row.payMethod]">{{ PAY_LABEL[row.payMethod] }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="客户当前余额（元）" width="150" align="right">
                <template #default="{ row }">{{ balanceYuan(row.customerId) }}</template>
              </el-table-column>
              <el-table-column label="班次" min-width="110">
                <template #default="{ row }">
                  {{ orderShiftName(row.shiftId) }}
                  <el-tag v-if="row.shiftId !== store.currentShift?.id" size="small" type="info">冻结</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="已退/可退（元）" width="130" align="right">
                <template #default="{ row }">
                  {{ centsToYuan(store.refundedAmount(row.id)) }} / {{ centsToYuan(store.remainingRefundable(row.id)) }}
                </template>
              </el-table-column>
              <el-table-column label="时间" width="160">
                <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-tab-pane>
      </el-tabs>
    </div>
  </main>
</template>
