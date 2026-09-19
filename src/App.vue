<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fmtMoney, useSettlementStore } from "./store";
import OrderDesk from "./components/OrderDesk.vue";
import RefundDesk from "./components/RefundDesk.vue";
import CustomerPanel from "./components/CustomerPanel.vue";
import ShiftLedger from "./components/ShiftLedger.vue";

const store = useSettlementStore();
const activeTab = ref("orders");
const auditProblems = ref<string[]>([]);

onMounted(() => {
  auditProblems.value = store.audit();
});

const metrics = computed(() => {
  const storedTotal = store.db.customers.reduce((s, c) => s + store.customerBalance(c.id), 0);
  const open = store.openShift;
  const t = open ? store.shiftTotals(open.id) : null;
  return [
    {
      label: "储值账户总余额（实时推导）",
      value: fmtMoney(storedTotal),
      hint: "= 全部充值 − 扣款 + 退款补回"
    },
    {
      label: open ? `当班收款 · ${open.code}` : "当前无进行中班次",
      value: t ? fmtMoney(t.storedNet + t.cashSales - t.cashRefundIn + t.digitalSales - t.digitalRefundIn) : "冻结中",
      hint: t
        ? `储值净额 ${fmtMoney(t.storedNet)} · 现金 ${fmtMoney(t.cashSales - t.cashRefundIn)} · 电子 ${fmtMoney(t.digitalSales - t.digitalRefundIn)}`
        : "交班后订单与余额冻结"
    },
    {
      label: "已结算订单 / 退款 / 冲正",
      value: `${store.db.orders.length} / ${store.db.refunds.length} / ${store.db.corrections.length}`,
      hint: "冲正只新增不覆盖，旧值全程保留"
    }
  ];
});

const tabs = [
  { key: "orders", label: "加油结算" },
  { key: "refunds", label: "退款受理" },
  { key: "customers", label: "客户与储值" },
  { key: "shifts", label: "班次与冲正台账" }
] as const;
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 储值账户结算台</p>
          <h1>加油站储值账户结算台</h1>
          <p class="subtitle">
            整笔订单结算、储值余额扣款校验、已结算订单退款、交班冻结与带原因冲正；
            数据原子落盘 localStorage，刷新后账务一致。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Pinia</span>
          <span class="tag">Element Plus</span>
          <span class="tag">localStorage 落盘</span>
        </div>
      </header>

      <el-alert
        v-for="p in auditProblems"
        :key="p"
        :title="p"
        type="error"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
      />
      <el-alert
        v-if="auditProblems.length === 0"
        title="账务自检通过：流水余额、退款上限、班次冻结关系一致（每次刷新自动校验）"
        type="success"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      />

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
          <p class="hint">{{ m.hint }}</p>
        </article>
      </section>

      <el-tabs v-model="activeTab" class="main-tabs">
        <el-tab-pane v-for="t in tabs" :key="t.key" :label="t.label" :name="t.key" />
      </el-tabs>

      <section class="tab-body">
        <OrderDesk v-if="activeTab === 'orders'" />
        <RefundDesk v-else-if="activeTab === 'refunds'" />
        <CustomerPanel v-else-if="activeTab === 'customers'" />
        <ShiftLedger v-else />
      </section>
    </div>
  </main>
</template>
