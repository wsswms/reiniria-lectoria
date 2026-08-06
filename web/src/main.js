import { createApp } from "vue";
import { darkTheme } from "naive-ui";
import App from "./App.vue";

createApp(App).provide("theme", darkTheme).mount("#app");
