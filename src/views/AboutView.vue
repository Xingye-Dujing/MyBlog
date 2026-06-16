<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="about-page">
    <div class="about-header">
      <button class="back-btn" @click="router.push({ name: 'home' })">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>返回</span>
      </button>
    </div>

    <div class="about-content">
      <div class="about-card">
        <div class="avatar-section">
          <img src="/img/profile/profile-photo.jpg" class="avatar" alt="Avatar" />
          <div class="avatar-info">
            <h2 class="name">Xingye-Dujing</h2>
            <p class="role">非专业人士 & 编程爱好者</p>
          </div>
        </div>

        <div class="bio-section">
          <h3 class="section-title">
            <svg
              class="title-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            个人简介
          </h3>
          <p class="bio-text">尊崇极简，热爱技术。</p>
          <p class="bio-text">编程计算机都是自学，纯业余。目前堪堪达到入门级别（甚至门也没入）。</p>
          <p class="bio-text">
            下面的能力条是以我的 Python 水平为单位 1
            进行衡量，我会的也并没有全指出。更多详情请见“编程学习历程”对话。
          </p>
        </div>

        <div class="skills-section">
          <h3 class="section-title">
            <svg
              class="title-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="16 18 22 12 16 6"></polyline>
              <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
            技术栈
          </h3>
          <div class="skills-grid">
            <div class="skill-item">
              <span class="skill-name">Python</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 100%"></div>
              </div>
            </div>
            <div class="skill-item">
              <span class="skill-name">C/C++</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 50%"></div>
              </div>
            </div>
            <div class="skill-item">
              <span class="skill-name">Haskell</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 25%"></div>
              </div>
            </div>
            <div class="skill-item">
              <span class="skill-name">JavaScript</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 20%"></div>
              </div>
            </div>
            <div class="skill-item">
              <span class="skill-name">SWI-Prolog</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 10%"></div>
              </div>
            </div>
            <div class="skill-item">
              <span class="skill-name">Node.js</span>
              <div class="skill-bar">
                <div class="skill-fill" style="width: 5%"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="contact-section">
          <h3 class="section-title">
            <svg
              class="title-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"
              ></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
            联系方式
          </h3>
          <div class="contact-links">
            <a href="mailto:1933679780@qq.com" class="contact-link">
              <span>1933679780@qq.com</span>
            </a>
            <a class="contact-link">
              <span>Delta Chat（我的二维码在 Delta Chat 对话中）</span>
            </a>
            <a href="https://github.com/Xingye-Dujing" class="contact-link">
              <span>https://github.com/Xingye-Dujing</span>
            </a>
            <a href="https://gitee.com/Xingye-Dujing" class="contact-link">
              <span>https://gitee.com/Xingye-Dujing</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-page {
  min-height: 100vh;
  background: #fafafa;
}

.about-header {
  padding: 16px 24px;
  border-bottom: 1.5px solid #e0e0e0;
  background: #fff;
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  cursor: pointer;
  color: #333;
  padding: 6px 12px;
  border-radius: 6px;
  font-family: serif;
  font-size: 0.9rem;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.back-btn:hover {
  background: #f0f0f0;
  color: #000;
}

.back-btn svg {
  width: 20px;
  height: 20px;
}

.about-content {
  display: flex;
  justify-content: center;
  padding: 40px 20px;
}

.about-card {
  max-width: 640px;
  width: 100%;
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 12px;
  padding: 40px;
}

.avatar-section {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 36px;
  padding-bottom: 36px;
  border-bottom: 1px solid #f0f0f0;
}

.avatar {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border: 2px solid #000;
  object-fit: cover;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.avatar:hover {
  transform: scale(1.05) rotate(3deg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.avatar-info {
  flex: 1;
}

.name {
  font-size: 1.6rem;
  font-weight: 200;
  color: #000;
  margin: 0 0 8px;
  letter-spacing: 2px;
}

.role {
  font-size: 0.9rem;
  color: #888;
  margin: 0;
  letter-spacing: 1px;
}

.bio-section,
.skills-section,
.contact-section {
  margin-bottom: 32px;
}

.contact-section {
  margin-bottom: 0;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 1.15rem;
  font-weight: 400;
  color: #000;
  margin: 0 0 20px;
  letter-spacing: 2px;
}

.title-icon {
  width: 22px;
  height: 22px;
  color: #000;
}

.bio-text {
  font-size: 0.95rem;
  line-height: 1.8;
  color: #555;
  margin: 0;
  text-indent: 2em;
}

.skills-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.skill-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-name {
  font-size: 0.85rem;
  font-weight: 400;
  color: #555;
  letter-spacing: 1px;
}

.skill-bar {
  width: 100%;
  height: 6px;
  background-color: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
}

.skill-fill {
  height: 100%;
  background-color: #000;
  border-radius: 3px;
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
}

.contact-links {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.contact-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  text-decoration: none;
  color: #555;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.contact-link:hover {
  border-color: #000;
  transform: translateX(5px);
  color: #000;
}

.contact-icon {
  width: 24px;
  filter: brightness(0) grayscale(1);
}

.contact-link span {
  font-size: 0.9rem;
  letter-spacing: 0.5px;
}

@media (max-width: 768px) {
  .about-header {
    padding-top: calc(16px + env(safe-area-inset-top));
  }

  .back-btn {
    margin-left: -14px;
    min-height: 44px;
  }

  .about-content {
    padding: 20px 12px;
    padding-bottom: calc(20px + env(safe-area-inset-bottom));
  }

  .about-card {
    padding: 24px 16px;
  }

  .avatar-section {
    flex-direction: column;
    text-align: center;
    gap: 16px;
  }

  .avatar {
    width: 80px;
    height: 80px;
  }

  .name {
    font-size: 1.3rem;
  }

  .role {
    font-size: 0.85rem;
  }

  .section-title {
    font-size: 1.05rem;
  }

  .bio-text {
    font-size: 0.9rem;
  }

  .contact-link {
    min-height: 48px;
  }
}

@media print {
  .about-header {
    display: none;
  }

  .about-page {
    background: #fff;
  }

  .about-card {
    border: 1px solid #000;
    box-shadow: none;
  }
}
</style>
