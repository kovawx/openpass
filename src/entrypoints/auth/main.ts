import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installRuntimeErrorReporter } from '@/utils/runtimeErrors';
import '@/assets/styles';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
installRuntimeErrorReporter(app, 'auth');
app.mount('#app');
