import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import { useChatStore } from '../stores/chat'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/chat/:id',
      name: 'chat',
      component: HomeView,
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('../views/AboutView.vue'),
    },
    {
      path: '/timeline',
      name: 'timeline',
      component: () => import('../views/TimelineView.vue'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      redirect: '/',
    },
  ],
})

router.beforeEach((to) => {
  if (to.name === 'chat') {
    try {
      const chatStore = useChatStore()
      const exists = chatStore.chats.some((c) => c.id === to.params.id)
      if (!exists) return { name: 'home' }
    } catch {
      // store not ready, allow navigation
    }
  }
})

export default router
