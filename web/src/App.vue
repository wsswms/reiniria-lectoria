<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NCheckbox, NConfigProvider, NDivider, NEmpty, NForm, NFormItem, NInput, NInputNumber, NLayout, NLayoutContent, NLayoutHeader, NList, NListItem, NSpace, NSelect, NSpin, NTag } from "naive-ui";
import { session, workspaces, workflow, providerConfig } from "./api.js";
import TranslationWorkbench from "./TranslationWorkbench.vue";
import KnowledgePanel from "./KnowledgePanel.vue";

const theme = inject("theme");
const loggedIn = ref(false); const loading = ref(true); const busy = ref(false); const error = ref("");
const password = ref(""); const newWorkspace = ref(""); const items = ref([]); const selected = ref(null); const workflowItems = ref([]);
const currentPassword = ref(""); const replacementPassword = ref("");
const title = ref(""); const format = ref("markdown"); const content = ref(""); const targetLanguage = ref("zh-CN");
const imported = ref(null); const createdWorkflow = ref(null);
const providerState = ref({ revision: 0, sources: [], presets: [], adapters: {} });
const sourceId = ref(""); const sourceName = ref(""); const adapterId = ref("deepseek"); const modelId = ref("deepseek-v4-flash"); const credential = ref("");
const presetId = ref("translation-default"); const presetStage = ref("translation"); const presetSourceId = ref(""); const presetThinking = ref(false); const presetTemperature = ref(0.2); const presetTools = ref("");
const contextState = ref(null); const taskState = ref(null);
const offlineRun = ref(null);
const currentLabel = computed(() => selected.value?.displayName ?? "未选择工作区");
const formatOptions = [{ label: "Markdown", value: "markdown" }, { label: "HTML", value: "html" }, { label: "纯文本", value: "text" }];
const adapterOptions = [{ label: "DeepSeek", value: "deepseek" }, { label: "Google Gemini", value: "google-gemini" }, { label: "OpenAI", value: "openai" }];
const modelOptions = computed(() => (providerState.value.adapters[adapterId.value]?.models ?? []).map((value) => ({ label: value, value })));
const translationPresets = computed(() => providerState.value.presets.filter((item) => item.stage === "translation").map((item) => ({ label: `${item.presetId} · ${item.sourceId}/${item.modelId}`, value: item.presetId })));

async function restoreWorkflow() {
  createdWorkflow.value = null; contextState.value = null; taskState.value = null; imported.value = null;
  if (!selected.value) { workflowItems.value = []; return; }
  workflowItems.value = await workflow.list(selected.value.workspaceId);
  const saved = workflowItems.value[0];
  if (!saved) return;
  createdWorkflow.value = await workflow.get(selected.value.workspaceId, saved.workflowId);
  try { contextState.value = await workflow.getContext(selected.value.workspaceId, saved.workflowId); } catch { contextState.value = null; }
}
async function loadWorkspaces() { items.value = await workspaces.list(); if (!selected.value || !items.value.some((item) => item.workspaceId === selected.value.workspaceId)) selected.value = items.value[0] ?? null; await restoreWorkflow(); }
async function selectWorkspace(item) { if (!item || item.workspaceId === selected.value?.workspaceId) return; selected.value = item; await restoreWorkflow(); }
async function loadProviderConfig() { providerState.value = await providerConfig.list(); if (!modelOptions.value.some((item) => item.value === modelId.value)) modelId.value = modelOptions.value[0]?.value ?? ""; if (!translationPresets.value.some((item) => item.value === presetId.value)) presetId.value = translationPresets.value[0]?.value ?? ""; }
async function restore() { try { await session.get(); loggedIn.value = true; await loadWorkspaces(); await loadProviderConfig(); } catch (cause) { if (cause.status !== 401) error.value = cause.message; } finally { loading.value = false; } }
async function login() { busy.value = true; error.value = ""; try { await session.login(password.value); password.value = ""; loggedIn.value = true; await loadWorkspaces(); await loadProviderConfig(); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function createWorkspace() { if (!newWorkspace.value.trim()) return; busy.value = true; error.value = ""; try { selected.value = await workspaces.create(newWorkspace.value.trim()); newWorkspace.value = ""; await loadWorkspaces(); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function importDocument() { if (!selected.value || !title.value.trim() || !content.value.trim()) return; busy.value = true; error.value = ""; imported.value = null; createdWorkflow.value = null; try { imported.value = await workflow.importDocument(selected.value.workspaceId, { title: title.value.trim(), format: format.value, content: content.value }); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function confirmAndCreate() { if (!selected.value || !imported.value) return; busy.value = true; error.value = ""; try { await workflow.confirmImport(selected.value.workspaceId, imported.value.importId); createdWorkflow.value = await workflow.create(selected.value.workspaceId, { importId: imported.value.importId, workflowId: crypto.randomUUID(), targetLanguage: targetLanguage.value, plannerEnabled: true }); workflowItems.value = await workflow.list(selected.value.workspaceId); imported.value = { ...imported.value, confirmed: true }; } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function submitPlan() { if (!selected.value || !createdWorkflow.value) return; busy.value = true; error.value = ""; try { createdWorkflow.value = await workflow.submitPlan(selected.value.workspaceId, createdWorkflow.value.workflow.workflowId, createdWorkflow.value.planHead.version); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function decidePlan(decision) { if (!selected.value || !createdWorkflow.value) return; busy.value = true; error.value = ""; try { createdWorkflow.value = await workflow.decidePlan(selected.value.workspaceId, createdWorkflow.value.workflow.workflowId, createdWorkflow.value.planHead.version, decision); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function assembleContext() { if (!selected.value || !createdWorkflow.value) return; busy.value = true; error.value = ""; try { contextState.value = await workflow.assembleContext(selected.value.workspaceId, createdWorkflow.value.workflow.workflowId); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function decideContext(decision) { if (!selected.value || !contextState.value) return; busy.value = true; error.value = ""; try { contextState.value = await workflow.decideContext(selected.value.workspaceId, createdWorkflow.value.workflow.workflowId, contextState.value.head.version, decision); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function enqueueTranslation() { if (!selected.value || !createdWorkflow.value || !contextState.value || !presetId.value.trim()) return; busy.value = true; error.value = ""; try { const result = await workflow.enqueueTranslation(selected.value.workspaceId, createdWorkflow.value.workflow.workflowId, { presetId: presetId.value.trim(), stage: "translation", idempotencyKey: crypto.randomUUID() }); taskState.value = result.task; } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function runOfflineTranslation() { if (!selected.value || !taskState.value) return; busy.value = true; error.value = ""; try { offlineRun.value = await workflow.runNextOffline(selected.value.workspaceId); taskState.value = await workflow.getTask(selected.value.workspaceId, taskState.value.taskId); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function createProviderSource() { if (!sourceId.value.trim() || !credential.value.trim()) return; busy.value = true; error.value = ""; try { providerState.value = await providerConfig.createSource({ sourceId: sourceId.value.trim(), displayName: sourceName.value.trim() || sourceId.value.trim(), adapterId: adapterId.value, modelId: modelId.value, credential: credential.value, expectedRevision: providerState.value.revision }); sourceId.value = ""; sourceName.value = ""; credential.value = ""; } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function savePreset() { if (!presetId.value.trim() || !presetSourceId.value.trim()) return; busy.value = true; error.value = ""; try { providerState.value = await providerConfig.setPreset({ presetId: presetId.value.trim(), stage: presetStage.value, sourceId: presetSourceId.value, thinking: presetThinking.value, temperature: Number(presetTemperature.value), toolNames: presetTools.value.split(",").map((item) => item.trim()).filter(Boolean), expectedRevision: providerState.value.revision }); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function logout() { await session.logout(); loggedIn.value = false; selected.value = null; items.value = []; workflowItems.value = []; createdWorkflow.value = null; contextState.value = null; }
async function changePassword() { if (replacementPassword.value.length < 8) return; busy.value = true; error.value = ""; try { await session.changePassword(currentPassword.value, replacementPassword.value); currentPassword.value = ""; replacementPassword.value = ""; } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
onMounted(restore);
</script>

<template>
  <n-config-provider :theme="theme">
    <n-layout style="min-height: 100vh">
      <n-layout-header bordered style="padding: 18px 28px"><n-space justify="space-between"><strong>Reiniria Lectoria</strong><n-space v-if="loggedIn"><n-tag type="info">{{ currentLabel }}</n-tag><n-button text @click="logout">退出</n-button></n-space></n-space></n-layout-header>
      <n-layout-content content-style="max-width: 880px; margin: 0 auto; padding: 40px 24px">
        <n-spin v-if="loading" />
        <n-card v-else-if="!loggedIn" title="登录" style="max-width: 420px; margin: 40px auto"><n-form @submit.prevent="login"><n-form-item label="管理员密码"><n-input v-model:value="password" type="password" show-password-on="click" autocomplete="current-password" @keyup.enter="login" /></n-form-item><n-button type="primary" block :loading="busy" @click="login">登录</n-button></n-form></n-card>
        <template v-else>
          <n-space vertical size="large" style="width: 100%">
            <n-alert v-if="error" type="error" :title="error" />
            <n-card title="登录密码"><n-space><n-input v-model:value="currentPassword" type="password" show-password-on="click" placeholder="当前密码" autocomplete="current-password" /><n-input v-model:value="replacementPassword" type="password" show-password-on="click" placeholder="新密码（至少 8 位）" autocomplete="new-password" /><n-button :loading="busy" :disabled="replacementPassword.length < 8 || !currentPassword" @click="changePassword">轮换密码</n-button></n-space></n-card>
            <n-card title="工作区"><n-space><n-input v-model:value="newWorkspace" placeholder="新工作区名称" @keyup.enter="createWorkspace" /><n-button type="primary" :loading="busy" @click="createWorkspace">创建</n-button></n-space><n-list v-if="items.length" bordered style="margin-top: 24px"><n-list-item v-for="item in items" :key="item.workspaceId"><n-button text @click="selectWorkspace(item)">{{ item.displayName }}</n-button><n-tag style="margin-left: 12px">{{ item.state ?? "active" }}</n-tag></n-list-item></n-list><n-empty v-else description="还没有工作区" style="margin-top: 24px" /><n-divider v-if="workflowItems.length" /><n-list v-if="workflowItems.length" bordered><n-list-item v-for="item in workflowItems" :key="item.workflowId"><n-space justify="space-between" style="width:100%"><span>{{ item.workflowId.slice(0, 8) }} · {{ item.targetLanguage }}</span><n-space><n-tag>{{ item.flowState }}</n-tag><n-tag>{{ item.planState }}</n-tag><n-tag>{{ item.contextState ?? "未组装 Context" }}</n-tag></n-space></n-space></n-list-item></n-list></n-card>
            <n-card v-if="selected" title="导入文档并创建翻译工作流">
              <n-form label-placement="top"><n-form-item label="文档标题"><n-input v-model:value="title" placeholder="例如：产品说明" /></n-form-item><n-space><n-form-item label="格式"><n-select v-model:value="format" :options="formatOptions" style="width: 160px" /></n-form-item><n-form-item label="目标语言"><n-input v-model:value="targetLanguage" placeholder="zh-CN" /></n-form-item></n-space><n-form-item label="正文"><n-input v-model:value="content" type="textarea" :autosize="{ minRows: 8, maxRows: 18 }" placeholder="粘贴 Markdown、HTML 或纯文本" /></n-form-item><n-space><n-button type="primary" :loading="busy" :disabled="!title.trim() || !content.trim()" @click="importDocument">解析预览</n-button><n-button v-if="imported" type="success" :loading="busy" @click="confirmAndCreate">确认并创建翻译</n-button></n-space></n-form>
              <n-divider v-if="imported" /><n-space v-if="imported" vertical><n-tag type="info">解析完成：{{ imported.importId }}</n-tag><span>诊断：{{ imported.diagnostics?.length ?? 0 }} 项；当前状态：{{ imported.confirmed ? "已确认" : "待确认" }}</span><template v-if="createdWorkflow"><n-tag type="success">工作流已创建：{{ createdWorkflow.workflow.workflowId }}</n-tag><span>计划状态：{{ createdWorkflow.planHead.state }}</span><n-space><n-button v-if="createdWorkflow.planHead.state === 'draft'" :loading="busy" @click="submitPlan">提交计划</n-button><n-button v-if="createdWorkflow.planHead.state === 'pending-user'" type="success" :loading="busy" @click="decidePlan('approved')">批准计划</n-button><n-button v-if="createdWorkflow.planHead.state === 'pending-user'" secondary :loading="busy" @click="decidePlan('rejected')">退回修改</n-button></n-space></template></n-space>
            </n-card>
            <n-card title="LLM / 工具来源配置">
              <n-space vertical>
                <span>凭据只保存在服务端，不会回显到浏览器。</span>
                <n-space><n-input v-model:value="sourceId" placeholder="来源 ID，如 deepseek-official" /><n-input v-model:value="sourceName" placeholder="显示名称" /><n-select v-model:value="adapterId" :options="adapterOptions" style="width: 170px" @update:value="modelId = modelOptions[0]?.value ?? ''" /><n-select v-model:value="modelId" :options="modelOptions" style="width: 190px" /><n-input v-model:value="credential" type="password" show-password-on="click" placeholder="API 凭据" /><n-button type="primary" :loading="busy" :disabled="!sourceId.trim() || !credential.trim()" @click="createProviderSource">保存来源</n-button></n-space>
                <n-list v-if="providerState.sources.length" bordered><n-list-item v-for="source in providerState.sources" :key="source.sourceId"><n-tag type="info">{{ source.sourceId }}</n-tag><span>{{ source.displayName }} / {{ source.adapterId }} / {{ source.modelId }}</span><n-tag type="success">凭据已配置</n-tag></n-list-item></n-list><n-empty v-else description="尚未配置来源" />
                <n-divider /><span>阶段配置决定实际 attempt；Web Search 工具只有兼容模型可保存。</span>
                <n-space><n-input v-model:value="presetId" placeholder="Preset ID" style="width:170px" /><n-select v-model:value="presetStage" :options="[{label:'翻译',value:'translation'},{label:'研究',value:'research'},{label:'QA',value:'qa'},{label:'词典',value:'dictionary'},{label:'实体',value:'entity'},{label:'Web Search',value:'web-search'}]" style="width:130px" /><n-select v-model:value="presetSourceId" :options="providerState.sources.map((item) => ({ label: `${item.sourceId} / ${item.modelId}`, value: item.sourceId }))" placeholder="选择来源" style="width:220px" /><n-checkbox v-model:checked="presetThinking">thinking</n-checkbox><n-input-number v-model:value="presetTemperature" :min="0" :max="2" :step="0.1" style="width:120px" /><n-input v-model:value="presetTools" placeholder="工具：number,web-search" style="width:220px" /><n-button type="primary" :loading="busy" :disabled="!presetSourceId" @click="savePreset">保存阶段配置</n-button></n-space>
                <n-list v-if="providerState.presets.length" bordered><n-list-item v-for="preset in providerState.presets" :key="preset.presetId"><n-space><n-tag type="info">{{preset.stage}}</n-tag><span>{{preset.presetId}} · {{preset.sourceId}} / {{preset.modelId}}</span><n-tag v-if="preset.toolNames.includes('web-search')" type="warning">Web Search 兼容已校验</n-tag></n-space></n-list-item></n-list>
              </n-space>
            </n-card>
            <n-card v-if="createdWorkflow" title="Context 与翻译任务">
              <n-space vertical>
                <n-space v-if="!contextState"><n-button :loading="busy" :disabled="createdWorkflow.planHead.state !== 'approved'" @click="assembleContext">组装 Context</n-button><span>需要先批准计划</span></n-space>
                <template v-else><n-tag type="info">Context：{{ contextState.head.state }}</n-tag><n-space v-if="contextState.head.state === 'pending-user'"><n-button type="success" :loading="busy" @click="decideContext('approved')">批准 Context</n-button><n-button secondary :loading="busy" @click="decideContext('rejected')">退回 Context</n-button></n-space><n-space v-if="contextState.head.state === 'approved' && !taskState"><n-select v-model:value="presetId" :options="translationPresets" placeholder="选择翻译 StagePreset" style="width:280px" /><n-button type="primary" :loading="busy" :disabled="!translationPresets.length" @click="enqueueTranslation">创建翻译任务</n-button></n-space><n-tag v-if="taskState" type="warning">任务：{{ taskState.task?.state ?? taskState.state }}</n-tag></template>
              </n-space>
            </n-card>
            <TranslationWorkbench v-if="createdWorkflow && selected" :workspace-id="selected.workspaceId" :workflow-state="createdWorkflow" :task-state="taskState" :translation-request="{ presetId, stage: 'translation' }" />
            <KnowledgePanel v-if="selected" :workspace-id="selected.workspaceId" />
          </n-space>
        </template>
      </n-layout-content>
    </n-layout>
  </n-config-provider>
</template>
