import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useChatStore } from './stores/chat'
import { useCommentStore } from './stores/comment'

import 'highlight.js/styles/github.css'
import 'katex/dist/katex.min.css'

const app = createApp(App)

app.config.errorHandler = (err, instance, info) => {
  console.error('[Vue Error]', err, '\n  component:', instance?.$options?.name || 'anonymous', '\n  info:', info)
}

app.use(createPinia())
app.use(router)

// Initialize stores
const chatStore = useChatStore()
const commentStore = useCommentStore()
chatStore.init()
commentStore.init()

app.mount('#app')
