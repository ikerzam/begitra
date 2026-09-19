import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/main.css";

import { createApp } from "vue";

import App from "./app/App.vue";
import { i18n } from "./i18n";

createApp(App).use(i18n).mount("#app");
