<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fmtDateTime, fmtMoney, useSettlementStore } from "../store";

const store = useSettlementStore();

const name = ref("");
const phone = ref("");
const initialTopup = ref<number>(0);

function addCustomer() {
  try {
    const c = store.addCustomer(name.value, phone.value, initialTopup.value);
    ElMessage.success(`客户 ${c.name} 已开卡${initialTopup.value ? `，充值 ${fmtMoney(initialTopup.value)}` : ""}`);
    name.value = "";
    phone.value = "";
    initialTopup.value = 0;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const topupTarget = ref<string | null>(null);
const topupAmount = ref<number>(0);

async function doTopup() {
  if (!topupTarget.value || !(topupAmount.value > 0)) {
    ElMessage.warning("请选择客户并填写充值金额");
    return;
  }
  try {
    store.topup(topupTarget.value, topupAmount.value);
    ElMessage.success(`已充值 ${fmtMoney(topupAmount.value)}`);
    topupAmount.value = 0;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const rows = computed(() =>
  store.db.customers.map((c) => {
    const ledger = store.db.ledger
      .filter((e) => e.customerId === c.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const topupTotal = ledger.filter((e) => e.kind === "topup").reduce((s, e) => s + e.amount, 0);
    const saleTotal = -ledger.filter((e) => e.kind === "sale").reduce((s, e) => s + e.amount, 0);
    const refundTotal = ledger.filter((e) => e.kind === "refund_credit").reduce((s, e) => s + e.amount, 0);
    return {
      ...c,
      balance: store.customerBalance(c.id),
      topupTotal,
      saleTotal,
      refundTotal
    };
  })
);

const ledgerRows = computed(() =>
  [...store.db.ledger]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map((e) => ({
      ...e,
      customerName: store.customer(e.customerId)?.name ?? "?",
      shiftCode: store.shift(e.shiftId)?.code ?? "-",
      orderCode: store.order(e.orderId ?? "")?.code ?? null
    }))
);

const kindMeta: Record<string, { label: string; type: "success" | "danger" | "warning" }> = {
  topup: { label: "充值", type: "success" },
  sale: { label: "储值扣款", type: "danger" },
  refund_credit: { label: "退款补回", type: "warning" }
};

async function resetDemo() {
  try {
    await ElMessageBox.confirm("将清空当前数据并恢复演示账本，确定继续？", "重置演示数据", { type: "warning" });
    store.resetDemo();
    ElMessage.success("已恢复演示数据");
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <div class="two-col">
    <el-card class="entry-card" shadow="never">
      <template #header><span>开卡 / 充值（仅进行中班次可操作）</span></template>
      <el-form label-position="top" :disabled="!store.openShift" @submit.prevent>
        <el-form-item label="客户姓名">
          <el-input v-model="name" placeholder="如：赵明" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="phone" placeholder="选填" />
        </el-form-item>
        <el-form-item label="开卡同时充值（可选）">
          <el-input-number v-model="initialTopup" :min="0" :precision="2" :step="100" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" @click="addCustomer">开卡</el-button>

        <el-divider>老客户充值</el-divider>
        <el-form-item label="选择客户">
          <el-select v-model="topupTarget" filterable placeholder="选择客户" style="width: 100%">
            <el-option v-for="c in store.db.customers" :key="c.id" :label="`${c.name}（余额 ${fmtMoney(store.customerBalance(c.id))}）`" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="充值金额">
          <el-input-number v-model="topupAmount" :min="0" :precision="2" :step="100" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-button type="success" plain style="width: 100%" @click="doTopup">充值入账</el-button>
        <el-button text type="danger" style="width: 100%; margin-top: 8px" @click="resetDemo">恢复演示数据</el-button>
      </el-form>
    </el-card>

    <div class="stack-panels">
      <el-card shadow="never">
        <template #header><span>储值账户（余额 = 充值 − 扣款 + 退款补回，实时推导）</span></template>
        <el-table :data="rows" size="small" stripe empty-text="暂无客户">
          <el-table-column prop="name" label="客户" width="90" />
          <el-table-column prop="phone" label="手机号" width="130" />
          <el-table-column label="累计充值" width="110" align="right">
            <template #default="{ row }">{{ fmtMoney(row.topupTotal) }}</template>
          </el-table-column>
          <el-table-column label="累计扣款" width="110" align="right">
            <template #default="{ row }">{{ fmtMoney(row.saleTotal) }}</template>
          </el-table-column>
          <el-table-column label="退款补回" width="110" align="right">
            <template #default="{ row }">{{ fmtMoney(row.refundTotal) }}</template>
          </el-table-column>
          <el-table-column label="当前余额" width="120" align="right">
            <template #default="{ row }"><strong>{{ fmtMoney(row.balance) }}</strong></template>
          </el-table-column>
          <el-table-column label="开卡时间" min-width="120">
            <template #default="{ row }">{{ fmtDateTime(row.createdAt).slice(0, 16) }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header><span>最近储值流水</span></template>
        <el-table :data="ledgerRows" size="small" stripe empty-text="暂无流水" max-height="320">
          <el-table-column label="时间" width="118">
            <template #default="{ row }">{{ fmtDateTime(row.createdAt).slice(5) }}</template>
          </el-table-column>
          <el-table-column prop="customerName" label="客户" width="80" />
          <el-table-column label="类型" width="92">
            <template #default="{ row }">
              <el-tag :type="kindMeta[row.kind].type" size="small">{{ kindMeta[row.kind].label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="100" align="right">
            <template #default="{ row }">
              <span :class="row.amount < 0 ? 'money-out' : 'money-in'">
                {{ row.amount < 0 ? "-" : "+" }}{{ fmtMoney(Math.abs(row.amount)) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="余额" width="100" align="right">
            <template #default="{ row }">{{ fmtMoney(row.balanceAfter) }}</template>
          </el-table-column>
          <el-table-column prop="shiftCode" label="归属班次" width="150" />
          <el-table-column label="关联" min-width="120">
            <template #default="{ row }">{{ row.orderCode ?? "—" }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>
