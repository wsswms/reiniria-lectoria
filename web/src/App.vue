<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NConfigProvider, NEmpty, NForm, NFormItem, NInput, NLayout, NLayoutContent, NLayoutHeader, NList, NListItem, NSpace, NSpin, NTag, NSelect, NDivider } from "naive-ui";
import { session, workspaces, workflow } from "./api.js";

const theme = inject("theme");
const loggedIn = ref(false); const loading = ref(true); const busy = ref(false); const error = ref("");
const password = ref(""); const newWorkspace = ref(""); const items = ref([]); const selected = ref(null);
const title = ref(""); const format = ref("markdown"); const content = ref(""); const targetLanguage = ref("zh-CN");
const imported = ref(null); const createdWorkflow = ref(null);
const currentLabel = computed(() => selected.value?.displayName ?? "未选择工作区");
const formatOptions = [{ label: "Markdown", value: "markdown" }, { label: "HTML", value: "html" }, { label: "纯文本", value: "text" }];

async function loadWorkspaces() { items.value = await workspaces.list(); if (!selected.value && items.value[0]) selected.value = items.value[0]; }
async function restore() {
  try { await session.get(); loggedIn.value = true; await loadWorkspaces(); }
  catch (cause) { if (cause.status !== 401) error.value = cause.message; }
  finally { loading.value = false; }
}
async function login() {
  busy.value = true; error.value = "";
  try { await session.login(password.value); password.value = ""; loggedIn.value = true; await loadWorkspaces(); }
  catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
async function createWorkspace() {
  if (!newWorkspace.value.trim()) return;
  busy.value = true; error.value = "";
  try { selected.value = await workspaces.create(newWorkspace.value.trim()); newWorkspace.value = ""; await loadWorkspaces(); }
  catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
async function importDocument() {
  if (!selected.value || !title.value.trim() || !content.value.trim()) return;
  busy.value = true; error.value = ""; imported.value = null; createdWorkflow.value = null;
  try { imported.value = await workflow.importDocument(selected.value.workspaceId, { title: title.value.trim(), format: format.value, content: content.value }); }
  catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
async function confirmAndCreate() {
  if (!selected.value || !imported.value) return;
  busy.value = true; error.value = "";
  try {
    await workflow.confirmImport(selected.value.workspaceId, imported.value.importId);
    createdWorkflow.value = await workflow.create(selected.value.workspaceId, { importId: imported.value.importId, workflowId: crypto.randomUUID(), targetLanguage: targetLanguage.value, plannerEnabled: true });
  } catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
async function logout() { await session.logout(); loggedIn.value = false; selected.value = null; items.value = []; }
onMounted(restore);
</script>

<template>
  <n-config-provider :theme="theme">
    <n-layout style="min-height: 100vh">
      <n-layout-header bordered style="padding: 18px 28px"><n-space justify="space-between"><strong>Reiniria Lectoria</strong><n-space v-if="loggedIn"><n-tag type="info">{{ currentLabel }}</n-tag><n-button text @click="logout">退出</n-button></n-space></n-space></n-layout-header>
      <n-layout-content content-style="max-width: 880px; margin: 0 auto; padding: 40px 24px">
        <n-spin v-if="loading" />
        <n-card v-else-if="!loggedIn" title="登录" style="max-width: 420px; margin: 40px auto">
          <n-form @submit.prevent="login"><n-form-item label="管理员密码"><n-input v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" @keyup.enter="login" /></n-form-item><n-button type="primary" block :loading="busy" @click="login">登录</n-button></n-form>
        </n-card>
        <template v-else>
          <n-space vertical size="large" style="width: 100%"><n-alert v-if="error" type="error" :title="error" /><n-card title="工作区"><n-space><n-input v-model:value="newWorkspace" placeholder="新工作区名称" @keyup.enter="createWorkspace" /><n-button type="primary" :loading="busy" @click="createWorkspace">创建</n-button></n-space><n-list v-if="items.length" bordered style="margin-top: 24px"><n-list-item v-for="item in items" :key="item.workspaceId"><n-button text @click="selected = item">{{ item.displayName }}</n-button><n-tag style="margin-left: 12px">{{ item.state ?? "active" }}</n-tag></n-list-item></n-list><n-empty v-else description="还没有工作区" style="margin-top: 24px" /></n-card>
            <n-card v-if="selected" title="导入文档并创建翻译工作流"><n-form label-placement="top"><n-form-item label="文档标题"><n-input v-model:value="title" placeholder="例如：产品说明" /></n-form-item><n-space><n-form-item label="格式"><n-select v-model:value="format" :options="formatOptions" style="width: 160px" /></n-form-item><n-form-item label="目标语言"><n-input v-model:value="targetLanguage" placeholder="zh-CN" /></n-form-item></n-space><n-form-item label="正文"><n-input v-model:value="content" type="textarea" :autosize="{ minRows: 8, maxRows: 18 }" placeholder="粘贴 Markdown、HTML 或纯文本" /></n-form-item><n-space><n-button type="primary" :loading="busy" :disabled="!title.trim() || !content.trim()" @click="importDocument">解析预览</n-button><n-button v-if="imported" type="success" :loading="busy" @click="confirmAndCreate">确认并创建翻译</n-button></n-space></n-form><n-divider v-if="imported" /><n-space v-if="imported" vertical><n-tag type="info">解析完成：{{ imported.importId }}</n-tag><span>诊断：{{ imported.diagnostics?.length ?? 0 }} 项；当前状态：{{ imported.confirmed ? "已确认" : "待确认" }}</span><n-tag v-if="createdWorkflow" type="success">工作流已创建：{{ createdWorkflow.workflow.workflowId }}</n-tag></n-space></n-card>
          </n-space>
        </template>
      </n-layout-content>
    </n-layout>
  </n-config-provider>
</template>
