<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { fmtDateTime, fmtMoney, useSettlementStore } from "../store";

const store = useSettlementStore();

const newCode = ref("");
const openingCash = ref(1000);

function defaultCode() {
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  newCode.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 晚班`;
}
defaultCode();

function openShift() {
  try {
    store.openNewShift(newCode.value, openingCash.value);
    ElMessage.success("新班次已开班");
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

function closeShift() {
  try {
    store.closeShift();
    ElMessage.success("已交班：订单与储值余额即刻冻结，更正只能新增带原因的冲正记录");
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const shiftCards = computed(() =>
  [...store.db.shifts]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .map((s) => ({
      shift: s,
      totals: store.shiftTotals(s.id),
      orderCount: store.shiftOrders(s.id).length,
      refundCount: store.shiftRefunds(s.id).length,
      correctionCount: store.shiftCorrections(s.id).length
    }))
);

const correctionRows = computed(() =>
  [...store.db.corrections]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({
      ...c,
      orderCode: store.order(c.orderId)?.code ?? "—",
      shiftCode: store.shift(c.shiftId)?.code ?? "—",
      customerName: store.customer(store.order(c.orderId)?.customerId ?? null)?.name ?? "散客",
      refundCode: store.db.refunds.find((r) => r.id === c.refundId)?.code ?? "-"
    }))
);
</script>

<template>
  <div class="shift-page">
    <el-card shadow="never" class="shift-ops">
      <template #header><span>班次控制</span></template>
      <div v-if="store.openShift" class="open-shift-bar">
        <div>
          <el-tag type="success" effect="dark" size="small">进行中</el-tag>
          <strong style="margin-left: 10px; font-size: 16px">{{ store.openShift.code }}</strong>
          <span class="muted" style="margin-left: 12px">开班 {{ fmtDateTime(store.openShift.openedAt) }}</span>
        </div>
        <el-button type="danger" @click="closeShift">交班冻结</el-button>
      </div>
      <div v-else class="open-shift-bar">
        <div>
          <el-tag type="info" effect="dark" size="small">无进行中班次</el-tag>
          <span class="muted" style="margin-left: 10px">开班后才能录入订单 / 充值 / 受理退款</span>
        </div>
        <div class="open-form">
          <el-input v-model="newCode" style="width: 200px" placeholder="班次名称" />
          <el-input-number v-model="openingCash" :min="0" :precision="2" controls-position="right" style="width: 150px" />
          <el-button type="primary" @click="openShift">开班</el-button>
        </div>
      </div>
    </el-card>

    <div class="shift-cards">
      <el-card v-for="card in shiftCards" :key="card.shift.id" shadow="never" class="shift-card">
        <template #header>
          <div class="card-title">
            <span>{{ card.shift.code }}</span>
            <el-tag :type="card.shift.closedAt ? 'danger' : 'success'" size="small">
              {{ card.shift.closedAt ? `已交班 ${fmtDateTime(card.shift.closedAt).slice(5)}` : "进行中（可记账）" }}
            </el-tag>
          </div>
        </template>

        <div class="shift-stats">
          <div class="stat">
            <span>储值销售</span>
            <strong>{{ fmtMoney(card.totals.storedSales) }}</strong>
            <em v-if="card.totals.storedReversed > 0">
              含退款/冲正补回 −{{ fmtMoney(card.totals.storedReversed) }}，净额 {{ fmtMoney(card.totals.storedNet) }}
            </em>
          </div>
          <div class="stat">
            <span>现金收入</span>
            <strong>{{ fmtMoney(card.totals.cashSales) }}</strong>
            <em v-if="card.totals.cashRefundIn > 0">同班退款 −{{ fmtMoney(card.totals.cashRefundIn) }}</em>
            <em v-if="card.totals.cashCorrectedOut > 0">跨班冲正补回 −{{ fmtMoney(card.totals.cashCorrectedOut) }}</em>
            <em>账面净额 {{ fmtMoney(card.totals.cashNet) }}；交接现金 {{ fmtMoney(card.totals.cashHandover) }}（含备用金 {{ fmtMoney(card.shift.openingCash) }}）</em>
          </div>
          <div class="stat">
            <span>电子支付</span>
            <strong>{{ fmtMoney(card.totals.digitalSales) }}</strong>
            <em v-if="card.totals.digitalRefundIn > 0">同班退款 −{{ fmtMoney(card.totals.digitalRefundIn) }}</em>
            <em v-if="card.totals.digitalCorrectedOut > 0">跨班冲正补回 −{{ fmtMoney(card.totals.digitalCorrectedOut) }}</em>
            <em>账面净额 {{ fmtMoney(card.totals.digitalNet) }}</em>
          </div>
          <div class="stat">
            <span>储值充值（负债）</span>
            <strong>{{ fmtMoney(card.totals.topup) }}</strong>
            <em>订单 {{ card.orderCount }} 笔 · 本班受理退款 {{ card.refundCount }} 笔 · 冲正 {{ card.correctionCount }} 条</em>
            <em v-if="card.totals.cashCrossOut + card.totals.digitalCrossOut > 0">
              本班垫支跨班退款：现金 {{ fmtMoney(card.totals.cashCrossOut) }} / 电子 {{ fmtMoney(card.totals.digitalCrossOut) }}
            </em>
          </div>
        </div>
      </el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>冲正记录（冻结班次唯一允许的更正方式，只新增、不覆盖、保留旧值）</span>
          <el-tag size="small" type="warning">{{ correctionRows.length }} 条</el-tag>
        </div>
      </template>
      <el-table :data="correctionRows" size="small" stripe empty-text="暂无冲正（发生跨班退款时自动生成）">
        <el-table-column prop="code" label="冲正号" width="130" />
        <el-table-column label="生成时间" width="120">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt).slice(0, 16) }}</template>
        </el-table-column>
        <el-table-column prop="shiftCode" label="原班次（补回）" width="150" />
        <el-table-column prop="customerName" label="客户" width="76" />
        <el-table-column prop="orderCode" label="原订单" width="132" />
        <el-table-column prop="refundCode" label="退款单" width="132" />
        <el-table-column label="冲正额" width="92" align="right">
          <template #default="{ row }">−{{ fmtMoney(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="保留的旧值" min-width="320">
          <template #default="{ row }">
            <span class="old-values">
              原单实付 {{ fmtMoney(row.oldValue.orderAmount) }}；
              冲正前本班该方式销售 {{ fmtMoney(row.oldValue.shiftSalesBefore) }}、已冲正 {{ fmtMoney(row.oldValue.shiftRefundedBefore) }}；
              冲正后净额 {{ fmtMoney(row.oldValue.shiftNetAfter) }}
              <template v-if="row.oldValue.customerBalanceBefore !== null">
                ；客户操作前余额 {{ fmtMoney(row.oldValue.customerBalanceBefore) }}
              </template>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.reason }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
