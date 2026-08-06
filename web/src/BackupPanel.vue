<script setup>
import { onMounted, ref, watch } from "vue";
import { NAlert, NButton, NCard, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import { backups, upgrades } from "./api.js";

const props = defineProps({ workspaceId: { type: String, required: true } });
const emit = defineEmits(["restored"]);
const items = ref([]); const busy = ref(false); const error = ref("");
const preflight = ref(null);
async function load() { error.value = ""; try { items.value = await backups.list(props.workspaceId); } catch (cause) { error.value = cause.message; } }
async function create() { busy.value = true; error.value = ""; try { await backups.create(props.workspaceId); await load(); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function restore(item) { busy.value = true; error.value = ""; try { const restored = await backups.restore(item.backupId); emit("restored", restored); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
async function checkUpgrade() { busy.value = true; error.value = ""; try { preflight.value = await upgrades.preflight(props.workspaceId); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
watch(() => props.workspaceId, load); onMounted(load);
</script>
<template>
  <n-card title="备份与恢复">
    <n-space vertical style="width:100%">
      <n-alert v-if="error" type="error" :title="error" />
      <n-space justify="space-between"><span>备份只写入服务端数据根目录；恢复会创建新工作区，不覆盖现有工作区。</span><n-button type="primary" :loading="busy" @click="create">立即备份</n-button></n-space>
      <n-space align="center">
        <n-button secondary :loading="busy" @click="checkUpgrade">升级前检查</n-button>
        <n-tag v-if="preflight" :type="preflight.ready ? 'success' : 'error'">{{ preflight.ready ? '可升级' : '需先处理问题' }} · active tasks: {{ preflight.workspaces?.[0]?.activeTaskCount ?? 0 }}</n-tag>
      </n-space>
      <n-list v-if="items.length" bordered>
        <n-list-item v-for="item in items" :key="item.backupId"><n-space justify="space-between" style="width:100%"><span>{{ item.backupId }} · {{ item.schemaVersion }}</span><n-space><n-tag>{{ item.objectCount }} objects</n-tag><n-tag>{{ item.portableFactCount }} facts</n-tag><n-button size="small" :loading="busy" @click="restore(item)">恢复为新工作区</n-button></n-space></n-space></n-list-item>
      </n-list>
      <n-empty v-else description="尚无可恢复备份" />
    </n-space>
  </n-card>
</template>
