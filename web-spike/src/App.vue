<script setup>
import { inject, ref } from "vue";
import { NAlert, NButton, NConfigProvider, NInput, NLayout, NLayoutContent, NLayoutHeader, NSpace, NTag } from "naive-ui";

const theme = inject("theme");
const workflowId = ref("demo-workflow");
const state = ref("未查询");
const error = ref("");

async function queryWorkflow() {
  error.value = "";
  try {
    const response = await fetch("/api/v1/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "workflow:get", payload: { workflowId: workflowId.value } }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error?.message ?? "请求失败");
    state.value = result.data.state;
  } catch (cause) { error.value = cause.message; }
}
</script>

<template>
  <n-config-provider :theme="theme">
    <n-layout style="min-height: 100vh">
      <n-layout-header bordered style="padding: 20px 28px"><strong>Reiniria Lectoria</strong><n-tag type="info" style="margin-left: 12px">Vue WebUI Spike</n-tag></n-layout-header>
      <n-layout-content content-style="max-width: 760px; margin: 0 auto; padding: 40px 24px">
        <h1>工作流状态查询</h1>
        <p>验证 Vue 3、Vite、Naive UI 与当前 HTTP API 的最小接线。</p>
        <n-space vertical size="large">
          <n-input v-model:value="workflowId" aria-label="工作流 ID" />
          <n-button type="primary" @click="queryWorkflow">查询 WorkflowApi</n-button>
          <n-alert v-if="error" type="error" :title="error" />
          <n-alert v-else type="success" title="API 状态"><n-tag>{{ state }}</n-tag></n-alert>
        </n-space>
      </n-layout-content>
    </n-layout>
  </n-config-provider>
</template>
