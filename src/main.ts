import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/main.css";

import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./app/App.vue";
import { i18n } from "./i18n";

createApp(App).use(createPinia()).use(i18n).mount("#app");
