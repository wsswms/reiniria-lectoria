<script setup>
import { onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import { knowledge } from "./api.js";

const props = defineProps({ workspaceId: { type: String, required: true } });
const proposals = ref([]); const busy = ref(false); const error = ref("");
const labels = { draft: "待审核", approved: "已批准", rejected: "已拒绝" };
const sourceTitle = (proposal) => proposal.revision?.proposedSource?.content?.title
  ?? proposal.revision?.proposedSource?.content?.term ?? proposal.revision?.factId ?? "未命名提案";

async function load() { error.value = ""; try { proposals.value = await knowledge.proposals(props.workspaceId); } catch (cause) { error.value = cause.message; } }
async function decide(proposal, decision) {
  busy.value = true; error.value = "";
  try { await knowledge.decideProposal(props.workspaceId, proposal.proposalId, proposal.head.version, decision); await load(); }
  catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
async function apply(proposal) {
  busy.value = true; error.value = "";
  try { await knowledge.applyProposal(props.workspaceId, proposal.proposalId); await load(); }
  catch (cause) { error.value = cause.message; } finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <n-card title="知识提案" :segmented="{ content: true }">
    <n-alert v-if="error" type="error" style="margin-bottom: 12px">{{ error }}</n-alert>
    <n-empty v-if="!proposals.length" description="当前没有待审核的知识提案" />
    <n-list v-else bordered>
      <n-list-item v-for="proposal in proposals" :key="proposal.proposalId">
        <n-space vertical style="width:100%">
          <n-space justify="space-between"><span>{{ sourceTitle(proposal) }}</span><n-tag>{{ labels[proposal.head.state] ?? proposal.head.state }}</n-tag></n-space>
          <span>来源：{{ proposal.revision.evidenceKind }} · 操作：{{ proposal.revision.operation }} · 版本：{{ proposal.head.version }}</span>
          <span v-if="proposal.revision.proposedSource?.content?.body">{{ proposal.revision.proposedSource.content.body }}</span>
          <n-tag v-if="proposal.current === false" type="error">提案已失效：{{ proposal.staleReason ?? "证据或事实已变化" }}</n-tag>
          <n-space>
            <n-button v-if="proposal.head.state === 'draft'" size="small" type="success" :loading="busy" @click="decide(proposal, 'approved')">批准</n-button>
            <n-button v-if="proposal.head.state === 'draft'" size="small" secondary :loading="busy" @click="decide(proposal, 'rejected')">拒绝</n-button>
            <n-button v-if="proposal.head.state === 'approved'" size="small" type="primary" :loading="busy" @click="apply(proposal)">应用到知识库</n-button>
          </n-space>
        </n-space>
      </n-list-item>
    </n-list>
  </n-card>
</template>
