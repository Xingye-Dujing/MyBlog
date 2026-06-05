import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

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
      path: '/news',
      beforeEnter() {
        window.location.href = '/h5-news.html'
      }
    }
  ],
})

export default router
