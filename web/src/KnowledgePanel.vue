<script setup>
import { ref, onMounted } from "vue";
import { NButton, NCard, NEmpty, NForm, NFormItem, NInput, NList, NListItem, NSpace, NSelect, NTag } from "naive-ui";
import { knowledge } from "./api.js";
const props = defineProps({ workspaceId: { type: String, required: true } }); const query = ref(""); const language = ref("zh-CN"); const hits = ref([]); const facts = ref([]); const error = ref(""); const busy = ref(false);
const kind = ref("knowledge"); const title = ref(""); const body = ref(""); const source = ref("user"); const tags = ref(""); const targetLanguage = ref("zh-CN"); const translation = ref(""); const initialState = ref("draft");
const kindOptions = [{ label: "知识事实", value: "knowledge" }, { label: "术语", value: "term" }, { label: "风格规则", value: "style" }];
const stateOptions = [{ label: "草稿（停用）", value: "draft" }, { label: "立即启用", value: "active" }];
async function search() { if (!query.value.trim()) return; busy.value = true; error.value = ""; try { hits.value = await knowledge.search(props.workspaceId, { query: query.value.trim(), language: language.value, kinds: ["term", "style", "knowledge"], tags: [], documentIds: [], topK: 10 }); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function loadFacts() { try { facts.value = await knowledge.list(props.workspaceId); } catch (cause) { error.value = cause.message; } }
async function createFact() {
  if (!title.value.trim() || !body.value.trim()) return; busy.value = true; error.value = "";
  try {
    const content = kind.value === "term"
      ? { term: title.value.trim(), preferredTranslations: [{ language: targetLanguage.value.trim(), text: translation.value.trim() || body.value.trim() }], forbiddenTranslations: [], variants: [], note: body.value.trim() }
      : kind.value === "style"
        ? { title: title.value.trim(), description: body.value.trim(), severity: "warning", forbiddenPatterns: [], requiredPatterns: [] }
        : { title: title.value.trim(), body: body.value.trim(), tags: tags.value.split(",").map((item) => item.trim()).filter(Boolean), source: source.value.trim() || "user" };
    await knowledge.create(props.workspaceId, { kind: kind.value, language: language.value.trim(), initialState: initialState.value, content, scope: { targetLanguages: [], tags: [], documentIds: [] } });
    title.value = ""; body.value = ""; translation.value = ""; tags.value = ""; await loadFacts();
  } catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
async function activate(fact) { busy.value = true; error.value = ""; try { await knowledge.setState(props.workspaceId, { factId: fact.source.factId, expectedHeadVersion: fact.head.version, state: "active" }); await loadFacts(); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
onMounted(loadFacts);
</script>
<template><n-space vertical size="large" style="width:100%"><n-card title="本地知识库检索"><n-space><n-input v-model:value="query" placeholder="检索术语、风格规则或事实" @keyup.enter="search"/><n-input v-model:value="language" style="width:120px"/><n-button type="primary" :loading="busy" @click="search">检索</n-button></n-space><div v-if="error">{{error}}</div><n-list v-if="hits.length" bordered><n-list-item v-for="hit in hits" :key="`${hit.factId}-${hit.revisionId}`"><n-space vertical><n-space><n-tag>{{hit.kind}}</n-tag><span>{{hit.matchedField}} · {{hit.score}}</span></n-space><span>{{hit.snippet}}</span></n-space></n-list-item></n-list><n-empty v-else description="尚无检索结果"/></n-card>
<n-card title="手动添加知识"><n-form label-placement="top"><n-space><n-form-item label="类型"><n-select v-model:value="kind" :options="kindOptions" style="width:150px"/></n-form-item><n-form-item label="语言"><n-input v-model:value="language" style="width:130px"/></n-form-item><n-form-item label="保存状态"><n-select v-model:value="initialState" :options="stateOptions" style="width:150px"/></n-form-item></n-space><n-form-item :label="kind === 'term' ? '术语' : '标题'"><n-input v-model:value="title"/></n-form-item><n-form-item v-if="kind === 'term'" label="首选译法"><n-input v-model:value="translation"/></n-form-item><n-form-item label="内容/说明"><n-input v-model:value="body" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }"/></n-form-item><n-form-item v-if="kind === 'knowledge'" label="标签（逗号分隔）"><n-input v-model:value="tags"/></n-form-item><n-form-item v-if="kind === 'knowledge'" label="来源"><n-input v-model:value="source"/></n-form-item><n-button type="primary" :loading="busy" :disabled="!title.trim() || !body.trim()" @click="createFact">保存知识</n-button></n-form></n-card>
<n-card title="已录入知识"><n-list v-if="facts.length" bordered><n-list-item v-for="fact in facts" :key="fact.source.factId"><n-space justify="space-between" style="width:100%"><span>{{fact.source.content.title || fact.source.content.term}}</span><n-space><n-tag>{{fact.source.kind}}</n-tag><n-tag :type="fact.head.state === 'active' ? 'success' : 'warning'">{{fact.head.state === 'active' ? '已启用' : '草稿/停用'}}</n-tag><n-button v-if="fact.head.state !== 'active'" size="small" @click="activate(fact)">启用</n-button></n-space></n-space></n-list-item></n-list><n-empty v-else description="尚无手动知识"/></n-card></n-space></template>
