<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { fmtDateTime, fmtMoney, round2, useSettlementStore } from "../store";
import { PAY_METHOD_LABEL, type PayMethod } from "../types";

const store = useSettlementStore();

const orderId = ref<string | null>(null);
const amount = ref<number>(0);
const reason = ref("");

const selectedOrder = computed(() => (orderId.value ? store.order(orderId.value) : null));
const alreadyRefunded = computed(() => (orderId.value ? store.orderRefunded(orderId.value) : 0));
const maxRefund = computed(() =>
  selectedOrder.value ? round2(selectedOrder.value.amount - alreadyRefunded.value) : 0
);
const crossShift = computed(
  () => !!selectedOrder.value && !!store.openShift && selectedOrder.value.shiftId !== store.openShift.id
);
const frozen = computed(() => !store.openShift);

// 只能引用已结算订单：全部订单均已结算，但只能在开班状态下受理
const orderOptions = computed(() =>
  [...store.db.orders]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => {
      const refunded = store.orderRefunded(o.id);
      const name = store.customer(o.customerId)?.name ?? "散客";
      const sh = store.shift(o.shiftId);
      return {
        id: o.id,
        label: `${o.code}｜${name}｜${o.fuelType} ${o.liters}L｜实付 ${fmtMoney(o.amount)}（${PAY_METHOD_LABEL[o.method]}）｜${sh?.code}${sh?.closedAt ? "·已冻结" : ""}`,
        disabled: round2(o.amount - refunded) <= 0
      };
    })
);

function submit() {
  try {
    if (!orderId.value) throw new Error("请选择要退款的已结算订单");
    const r = store.createRefund({ orderId: orderId.value, amount: amount.value, reason: reason.value });
    ElMessage.success(
      r.crossShift
        ? `跨班退款 ${r.code} 已受理：原班冲正 ${fmtMoney(r.amount)} 已补记，资金计入本班`
        : `退款 ${r.code} 已受理，金额 ${fmtMoney(r.amount)}`
    );
    orderId.value = null;
    amount.value = 0;
    reason.value = "";
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const refundRows = computed(() =>
  [...store.db.refunds]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const o = store.order(r.orderId);
      return {
        ...r,
        customerName: store.customer(o?.customerId ?? null)?.name ?? "散客",
        orderCode: o?.code ?? "—",
        method: (o?.method ?? "cash") as PayMethod,
        methodLabel: PAY_METHOD_LABEL[o?.method ?? "cash"],
        shiftCode: store.shift(r.shiftId)?.code ?? "-",
        originalShiftCode: store.shift(o?.shiftId ?? "")?.code ?? "-",
        balanceAfter: r.balanceAfter,
        correctionCode: store.db.corrections.find((c) => c.id === r.correctionId)?.code ?? null
      };
    })
);
</script>

<template>
  <div class="two-col">
    <el-card class="entry-card" shadow="never">
      <template #header>
        <div class="card-title">
          <span>退款受理</span>
          <el-tag v-if="frozen" type="info" size="small">班次冻结中</el-tag>
          <el-tag v-else type="success" size="small">当班受理</el-tag>
        </div>
      </template>

      <el-form label-position="top" :disabled="frozen" @submit.prevent>
        <el-form-item label="引用已结算订单（全额退完的订单不可再选）">
          <el-select v-model="orderId" filterable placeholder="按订单号 / 客户选择" style="width: 100%">
            <el-option
              v-for="opt in orderOptions"
              :key="opt.id"
              :label="opt.label"
              :value="opt.id"
              :disabled="opt.disabled"
            />
          </el-select>
        </el-form-item>

        <template v-if="selectedOrder">
          <el-descriptions :column="2" border size="small" class="refund-meta">
            <el-descriptions-item label="原订单实付">{{ fmtMoney(selectedOrder.amount) }}</el-descriptions-item>
            <el-descriptions-item label="已退金额">{{ fmtMoney(alreadyRefunded) }}</el-descriptions-item>
            <el-descriptions-item label="支付方式">{{ PAY_METHOD_LABEL[selectedOrder.method] }}</el-descriptions-item>
            <el-descriptions-item label="原属班次">
              {{ store.shift(selectedOrder.shiftId)?.code }}{{ store.shift(selectedOrder.shiftId)?.closedAt ? "（已交班冻结）" : "" }}
            </el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="crossShift"
            type="warning"
            show-icon
            :closable="false"
            style="margin: 12px 0"
            :title="`跨班退款：将先在原班「${store.shift(selectedOrder.shiftId)?.code}」补记一条带原因的冲正（保留旧值）并补回余额，退款支出 ${fmtMoney(maxRefund)} 以内计入本班「${store.openShift?.code}」`"
          />

          <el-form-item :label="`退款金额（最多可退 ${fmtMoney(maxRefund)}）`">
            <el-input-number
              v-model="amount"
              :min="0.01"
              :max="maxRefund"
              :precision="2"
              :step="10"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="退款原因（必填，冲正记录将保留此原因与旧值）">
            <el-input v-model="reason" type="textarea" :rows="2" maxlength="100" show-word-limit placeholder="如：油枪跳枪 / 客户投诉油品质量" />
          </el-form-item>
          <el-button
            type="primary"
            style="width: 100%"
            :disabled="!orderId || amount <= 0 || amount > maxRefund || !reason.trim()"
            @click="submit"
          >
            {{ crossShift ? "先冲正原班，再计入本班并保存" : "保存退款" }}
          </el-button>
        </template>
        <el-empty v-else description="请选择一笔已结算订单" :image-size="72" />
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header><span>退款台账（客户 / 原订单 / 退款额 / 退款后余额）</span></template>
      <el-table :data="refundRows" size="small" stripe empty-text="暂无退款">
        <el-table-column prop="code" label="退款单号" width="132" />
        <el-table-column label="时间" width="118">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt).slice(5) }}</template>
        </el-table-column>
        <el-table-column prop="customerName" label="客户" width="76" />
        <el-table-column prop="orderCode" label="原订单" width="132" />
        <el-table-column label="退款额" width="92" align="right">
          <template #default="{ row }">-{{ fmtMoney(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="支付" width="88">
          <template #default="{ row }">
            <el-tag :type="row.method === 'stored' ? 'warning' : row.method === 'cash' ? 'info' : 'primary'" size="small">
              {{ row.methodLabel }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="退款后余额" width="104" align="right">
          <template #default="{ row }">
            {{ row.balanceAfter !== null ? fmtMoney(row.balanceAfter) : "退现/电付" }}
          </template>
        </el-table-column>
        <el-table-column label="班次" width="130">
          <template #default="{ row }">
            <div class="shift-cell">
              <span>{{ row.shiftCode }}</span>
              <el-tag v-if="row.crossShift" type="warning" size="small">
                跨班·冲正 {{ row.correctionCode }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.reason }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
