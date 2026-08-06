<script setup>
import { onUnmounted, ref, watch } from "vue";
import { NAlert, NButton, NCard, NEmpty, NInput, NList, NListItem, NSpace, NTag } from "naive-ui";
import { workflow } from "./api.js";

const props = defineProps({ workspaceId: { type: String, required: true }, workflowState: { type: Object, required: true }, taskState: { type: Object, default: null } });
const bundle = ref(null); const activeId = ref(null); const candidates = ref([]); const text = ref(""); const validation = ref(null); const exportRecord = ref(null); const task = ref(null); const error = ref(""); let timer = null;
const active = () => bundle.value?.segments.find((item) => item.segmentId === activeId.value) ?? null;
async function choose(item) { activeId.value = item.segmentId; text.value = item.text ?? ""; candidates.value = await workflow.listCandidates(props.workspaceId, props.workflowState.workflow.workflowId, item.segmentId); }
async function selectCandidate(candidate) { const item = active(); if (!item) return; try { await workflow.selectCandidate(props.workspaceId, props.workflowState.workflow.workflowId, item.segmentId, candidate.candidateId, item.version ?? null); await load(); const refreshed = active(); if (refreshed) await choose(refreshed); } catch (cause) { error.value = cause.message; } }
async function load() { bundle.value = await workflow.getBundle(props.workspaceId, props.workflowState.workflow.workflowId); if (!activeId.value && bundle.value.segments[0]) choose(bundle.value.segments[0]); }
async function edit() { const item = active(); if (!item) return; try { await workflow.editSegment(props.workspaceId, props.workflowState.workflow.workflowId, item.segmentId, item.version ?? null, text.value); await load(); } catch (cause) { error.value = cause.message; } }
async function validate() { try { validation.value = await workflow.validate(props.workspaceId, props.workflowState.workflow.workflowId); } catch (cause) { error.value = cause.message; } }
async function confirmWarning(item) { try { validation.value = await workflow.confirmWarning(props.workspaceId, props.workflowState.workflow.workflowId, validation.value.validationRunId, item.findingId); } catch (cause) { error.value = cause.message; } }
async function review() { try { await workflow.review(props.workspaceId, props.workflowState.workflow.workflowId, validation.value.validationRunId, props.workflowState.workflow.version); } catch (cause) { error.value = cause.message; } }
async function approve() { try { await workflow.approve(props.workspaceId, props.workflowState.workflow.workflowId, validation.value.validationRunId, props.workflowState.workflow.version); } catch (cause) { error.value = cause.message; } }
async function exportFile(format) { try { exportRecord.value = await workflow.export(props.workspaceId, props.workflowState.workflow.workflowId, validation.value.validationRunId, format); } catch (cause) { error.value = cause.message; } }
async function downloadFile() { if (!exportRecord.value?.exportId) return; const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/exports/${encodeURIComponent(exportRecord.value.exportId)}/download`, { credentials: "include" }); if (!response.ok) throw new Error("导出文件下载失败"); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = exportRecord.value.filename; link.click(); URL.revokeObjectURL(link.href); }
async function runOffline() { try { const result = await workflow.runNextOffline(props.workspaceId); task.value = props.taskState?.taskId ? await workflow.getTask(props.workspaceId, props.taskState.taskId) : result; await load(); } catch (cause) { error.value = cause.message; } }
async function poll() { if (!task.value?.taskId) return; try { task.value = await workflow.getTask(props.workspaceId, task.value.taskId); if (["completed", "failed", "canceled", "unknown-outcome"].includes(task.value.state)) { clearInterval(timer); timer = null; await load(); } } catch (cause) { error.value = cause.message; } }
function startPoll() { if (timer) clearInterval(timer); timer = setInterval(poll, 1500); }
watch(() => props.workflowState.workflow.workflowId, () => { bundle.value = null; validation.value = null; load().catch((cause) => { error.value = cause.message; }); }, { immediate: true });
watch(() => props.taskState, (value) => { task.value = value; if (value?.taskId && !timer) startPoll(); }, { immediate: true });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <n-space vertical size="large">
    <n-alert v-if="error" type="error" :title="error" />
    <n-card title="离线执行验收"><n-space><n-button type="warning" :disabled="!taskState" @click="runOffline">运行下一项 Fake Provider 任务</n-button><n-tag v-if="task">{{ task.status ?? task.state ?? '等待执行' }}</n-tag></n-space></n-card>
    <n-card v-if="candidates.length" title="当前段候选"><n-list bordered><n-list-item v-for="candidate in candidates" :key="candidate.candidateId"><n-space justify="space-between"><span>{{ candidate.text }}</span><n-button size="small" type="primary" @click="selectCandidate(candidate)">采用候选</n-button></n-space></n-list-item></n-list></n-card>
    <n-card title="分段翻译工作台"><n-button secondary @click="load">刷新分段</n-button><n-list v-if="bundle?.segments?.length" bordered><n-list-item v-for="item in bundle.segments" :key="item.segmentId"><n-button text @click="choose(item)">#{{ item.ordinal + 1 }} {{ item.sourceText.slice(0, 80) }}</n-button><n-tag style="margin-left: 10px">{{ item.text ? '已有译文' : '待翻译' }}</n-tag></n-list-item></n-list><template v-if="active()"><n-alert type="info" :title="active().sourceText" /><n-input v-model:value="text" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" /><n-button type="primary" @click="edit">保存编辑</n-button></template><n-empty v-else description="没有可编辑的分段" /></n-card>
    <n-card title="Validator、审核与导出"><n-button type="primary" @click="validate">运行确定性 Validator</n-button><n-list v-if="validation?.findings?.length" bordered><n-list-item v-for="item in validation.findings" :key="item.findingId">{{ item.severity }} · {{ item.code }}<n-button v-if="item.severity === 'warning'" size="small" @click="confirmWarning(item)">确认警告</n-button></n-list-item></n-list><n-space v-if="validation"><n-button @click="review">人工审核完成</n-button><n-button type="success" @click="approve">批准导出</n-button><n-button @click="exportFile('markdown')">导出 Markdown</n-button><n-button @click="exportFile('canonical')">导出 Canonical</n-button></n-space><n-space v-if="exportRecord"><n-alert type="success" :title="`导出完成：${exportRecord.filename}`" /><n-button type="primary" @click="downloadFile">下载文件</n-button></n-space></n-card>
  </n-space>
</template>
