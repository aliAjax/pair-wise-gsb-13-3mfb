<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { FUEL_TYPES, fmtDateTime, fmtMoney, round2, useSettlementStore } from "../store";
import { PAY_METHOD_LABEL, type PayMethod } from "../types";

const store = useSettlementStore();

const customerId = ref<string | null>(null);
const fuelType = ref<string>(FUEL_TYPES[0]);
const liters = ref<number>(0);
const unitPrice = ref<number>(7.5);
const method = ref<PayMethod>("stored");

const amount = computed(() => round2((liters.value || 0) * (unitPrice.value || 0)));
const balance = computed(() => (customerId.value ? store.customerBalance(customerId.value) : null));
const insufficient = computed(
  () => method.value === "stored" && (balance.value === null || balance.value < amount.value)
);
const frozen = computed(() => !store.openShift);

function submit() {
  try {
    const o = store.createOrder({
      customerId: method.value === "stored" ? customerId.value : customerId.value || null,
      fuelType: fuelType.value,
      liters: liters.value,
      unitPrice: unitPrice.value,
      method: method.value
    });
    ElMessage.success(`订单 ${o.code} 已结算，实付 ${fmtMoney(o.amount)}`);
    liters.value = 0;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

const recentOrders = computed(() =>
  [...store.db.orders]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12)
    .map((o) => ({
      ...o,
      customerName: store.customer(o.customerId)?.name ?? "散客",
      shiftCode: store.shift(o.shiftId)?.code ?? "-",
      frozen: !!store.shift(o.shiftId)?.closedAt,
      refunded: store.orderRefunded(o.id)
    }))
);
</script>

<template>
  <div class="two-col">
    <el-card class="entry-card" shadow="never">
      <template #header>
        <div class="card-title">
          <span>加油结算</span>
          <el-tag v-if="frozen" type="info" size="small">班次已冻结，请先开班</el-tag>
          <el-tag v-else type="success" size="small">当班可结算</el-tag>
        </div>
      </template>

      <el-form label-position="top" :disabled="frozen" @submit.prevent>
        <el-form-item label="客户（散客可选不选；储值支付必须选择客户）">
          <el-select v-model="customerId" clearable placeholder="散客 / 选择储值客户" style="width: 100%">
            <el-option v-for="c in store.db.customers" :key="c.id" :label="`${c.name}（余额 ${fmtMoney(store.customerBalance(c.id))}）`" :value="c.id" />
          </el-select>
        </el-form-item>

        <div class="form-row">
          <el-form-item label="油品">
            <el-select v-model="fuelType" style="width: 100%">
              <el-option v-for="f in FUEL_TYPES" :key="f" :label="f" :value="f" />
            </el-select>
          </el-form-item>
          <el-form-item label="单价（元/L）">
            <el-input-number v-model="unitPrice" :min="0.01" :precision="2" :step="0.05" controls-position="right" style="width: 100%" />
          </el-form-item>
        </div>

        <el-form-item label="加油升数（L）">
          <el-input-number v-model="liters" :min="0" :precision="2" :step="10" controls-position="right" style="width: 100%" />
        </el-form-item>

        <div class="amount-line">
          <span>本单应付（整笔）</span>
          <strong>{{ fmtMoney(amount) }}</strong>
          <span v-if="balance !== null" class="balance-hint">储值余额：{{ fmtMoney(balance) }}</span>
        </div>

        <el-form-item label="支付方式（整笔订单仅一种）">
          <el-radio-group v-model="method">
            <el-radio-button value="stored">储值扣款</el-radio-button>
            <el-radio-button value="cash">现金</el-radio-button>
            <el-radio-button value="digital">电子支付</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-alert
          v-if="method === 'stored' && !customerId"
          type="warning"
          :closable="false"
          show-icon
          title="未选择储值客户，散客只能使用现金或电子支付"
          style="margin-bottom: 12px"
        />
        <el-alert
          v-else-if="insufficient"
          type="error"
          :closable="false"
          show-icon
          :title="`储值余额不足，本单不能保存，请改用现金或电子支付（差额 ${fmtMoney(amount - (balance ?? 0))}）`"
          style="margin-bottom: 12px"
        />

        <el-button type="primary" size="large" style="width: 100%" :disabled="frozen || amount <= 0 || insufficient" @click="submit">
          结算并保存订单
        </el-button>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header><span>最近订单</span></template>
      <el-table :data="recentOrders" size="small" stripe empty-text="暂无订单">
        <el-table-column prop="code" label="订单号" width="132" />
        <el-table-column label="时间" width="118">
          <template #default="{ row }">{{ fmtDateTime(row.createdAt).slice(5) }}</template>
        </el-table-column>
        <el-table-column prop="customerName" label="客户" width="80" />
        <el-table-column prop="fuelType" label="油品" width="92" />
        <el-table-column label="升数" width="72" align="right">
          <template #default="{ row }">{{ row.liters }}L</template>
        </el-table-column>
        <el-table-column label="实付" width="92" align="right">
          <template #default="{ row }">{{ fmtMoney(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="支付" width="92">
          <template #default="{ row }">
            <el-tag :type="row.method === 'stored' ? 'warning' : row.method === 'cash' ? 'info' : 'primary'" size="small">
              {{ PAY_METHOD_LABEL[row.method as PayMethod] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已退" width="88" align="right">
          <template #default="{ row }">
            <span :class="{ refunded: row.refunded > 0 }">{{ row.refunded > 0 ? fmtMoney(row.refunded) : "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <el-tag :type="row.frozen ? 'danger' : 'success'" size="small" effect="plain">
              {{ row.frozen ? "已冻结" : "当班" }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
