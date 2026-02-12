// src/ReverseLayout.jsx
import React, { useEffect } from 'react'

export default function ReverseLayout({ children, enableRunes = false, isTransitioning = false }) {
  useEffect(() => {
    // 真·卢恩符文字符 (剔除乱码)
    const RUNES = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', '🜄', 'ᚷ', 'ᚹ', 'ᚺ', 'ᚾ', 'ᛁ', 'ᯣ', 'ᛇ', 'ᛈ', 'ᛉ', 'ᛊ', 'ᛏ', 'ᛒ', 'ᛖ', 'ᛗ', 'ᛚ', '𛆁', 'ᛟ', 'ᛞ']

    // 当前所有符文粒子
    const runes = []

    // 参数配置
    const NUM_RUNES = 35            // 屏幕上保持的符文数量
    const BASE_SPEED = 0.2          // 初始基础速度
    const NOISE = 0.1             // 漂浮噪声
    const DAMPING = 0.96            // 阻尼

    const FADE_IN = 800             // 淡入时间（ms）
    const FADE_OUT = 1200           // 淡出时间（ms）
    const LIFE_MIN = 4000           // 最短生命周期
    const LIFE_MAX = 8000           // 最长生命周期

    // 点击吸引脉冲参数
    const PULSE_FORCE = 0.15        // 吸引力度
    const PULSE_DURATION = 200      // 吸引持续时间（ms）
    const PULSE_RADIUS = 300        // 有效吸引半径

    let pulseTargetX = null
    let pulseTargetY = null
    let pulseEndTime = 0
    let rafId = null

    const randomLife = () => LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)

    // 检查位置是否在中心区域（避开框）
    const isInRestrictedArea = (x, y) => {
      const w = window.innerWidth
      const h = window.innerHeight
      // 中心 60% 宽度和 80% 高度视为“框”的区域，避免符文进入
      // 这里的框可能是指登录框或中间的主要内容区域
      // 简单起见，我们定义一个中心矩形区域，符文不应该出现在这里
      const centerX = w / 2
      const centerY = h / 2
      const restrictedWidth = 600  // 假设框宽约 500-600px
      const restrictedHeight = 500 // 假设框高约 400-500px

      return (
        x > centerX - restrictedWidth / 2 &&
        x < centerX + restrictedWidth / 2 &&
        y > centerY - restrictedHeight / 2 &&
        y < centerY + restrictedHeight / 2
      )
    }

    // 生成一个新的符文
    const spawnRune = () => {
      const w = window.innerWidth
      const h = window.innerHeight

      let x, y
      let attempts = 0
      // 尝试生成不在限制区域内的坐标
      do {
        x = Math.random() * w
        y = Math.random() * h
        attempts++
      } while (isInRestrictedArea(x, y) && attempts < 10)

      // 初始随机漂浮方向
      const angle = Math.random() * Math.PI * 2
      const speed = BASE_SPEED + Math.random() * BASE_SPEED
      const vx = Math.cos(angle) * speed
      const vy = Math.sin(angle) * speed

      const el = document.createElement('span')
      el.className = 'rune-particle'
      el.textContent = RUNES[Math.floor(Math.random() * RUNES.length)]
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      // 初始状态：透明，配合 JS 渐入
      el.style.opacity = '0'
      el.style.transform = 'translate(-50%, -50%) scale(0.8)'
      // 降低 z-index 确保不挡住内容，虽然逻辑上避开了，但在层级上也保证
      el.style.zIndex = '0' 

      document.body.appendChild(el)

      const createdAt = performance.now()
      const lifeTime = randomLife()

      runes.push({ el, x, y, vx, vy, createdAt, lifeTime })
    }

    // 初始化
    const initRunes = () => {
      for (let i = 0; i < NUM_RUNES; i++) {
        spawnRune()
      }
    }

    // 鼠标点击：触发一次短暂的“吸引脉冲”
    const handleClick = (e) => {
      pulseTargetX = e.clientX
      pulseTargetY = e.clientY
      pulseEndTime = performance.now() + PULSE_DURATION
    }

    window.addEventListener('click', handleClick)

    // 动画循环
    const tick = () => {
      const now = performance.now()
      const attracting = now < pulseEndTime
      const w = window.innerWidth
      const h = window.innerHeight

      for (let i = runes.length - 1; i >= 0; i--) {
        const rune = runes[i]
        const { el } = rune
        let { x, y, vx, vy, createdAt, lifeTime } = rune

        const age = now - createdAt

        // 1) 计算生命周期内的渐显 / 渐隐
        let opacity = 0
        let scale = 0.8

        if (age < FADE_IN) {
          // 淡入
          const t = age / FADE_IN
          opacity = t
          scale = 0.8 + 0.2 * t
        } else if (age > lifeTime - FADE_OUT) {
          // 淡出
          const t = Math.max(0, (lifeTime - age) / FADE_OUT)
          opacity = t
          scale = 0.8 + 0.2 * t
        } else {
          // 稳定期
          opacity = 1
          scale = 1
        }

        el.style.opacity = String(opacity * 0.7) // 整体最大透明度稍微低一点，避免太抢眼
        el.style.transform = `translate(-50%, -50%) scale(${scale})`

        // 2) 运动逻辑
        if (attracting && pulseTargetX != null && pulseTargetY != null) {
          // 吸引到点击点附近
          const dx = pulseTargetX - x
          const dy = pulseTargetY - y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1

          if (dist < PULSE_RADIUS) {
            // 距离越近，受力越强，但太近会减弱以避免穿模
            const strength = 1 - dist / PULSE_RADIUS
            const ax = (dx / dist) * PULSE_FORCE * strength
            const ay = (dy / dist) * PULSE_FORCE * strength

            vx += ax
            vy += ay
          }
        }

        // 阻尼 + 随机噪声（模拟空气流动）
        vx = vx * DAMPING + (Math.random() - 0.5) * NOISE
        vy = vy * DAMPING + (Math.random() - 0.5) * NOISE

        let nextX = x + vx
        let nextY = y + vy

        // 简单的避让逻辑：如果将要进入中心区域，给一个反向力
        if (isInRestrictedArea(nextX, nextY)) {
           // 计算中心点向量
           const centerX = w / 2
           const centerY = h / 2
           const dx = nextX - centerX
           const dy = nextY - centerY
           
           // 简单的排斥力，推向远离中心的方向
           vx += (dx > 0 ? 1 : -1) * 0.1
           vy += (dy > 0 ? 1 : -1) * 0.1
           
           // 更新位置稍微保守一点
           nextX = x + vx
           nextY = y + vy
        }

        x = nextX
        y = nextY

        rune.x = x
        rune.y = y
        rune.vx = vx
        rune.vy = vy

        el.style.left = `${x}px`
        el.style.top = `${y}px`

        // 3) 生命周期结束：删除并生成新的
        if (age > lifeTime) {
          el.remove()
          runes.splice(i, 1)
          spawnRune() // 保持数量恒定
        }
      }

      // 如果因为各种原因符文少了（比如被删除了），补齐
      while (runes.length < NUM_RUNES) {
        spawnRune()
      }

      rafId = requestAnimationFrame(tick)
    }

    initRunes()
    rafId = requestAnimationFrame(tick)

    // 清理（离开第一页或组件卸载时）
    return () => {
      window.removeEventListener('click', handleClick)
      if (rafId) cancelAnimationFrame(rafId)
      runes.forEach(({ el }) => el.remove())
    }
  }, []) // Removed dependency on enableRunes so it runs always

  // 生成转场用的符文环数据
  const transitionRunes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛟᛞ'.split('')

  return (
    <>
      {/* 幻觉转场层 */}
      {isTransitioning && (
        <div className="hallucination-overlay">
          <div className="magic-circle-container">
             <div className="magic-circle outer"></div>
             <div className="magic-circle inner"></div>
             <div className="rune-ring">
              {transitionRunes.map((char, i) => (
                <span 
                  key={i} 
                  className="rune-char"
                  style={{ 
                    transform: `rotate(${i * (360 / transitionRunes.length)}deg) translateY(-35vmin)` 
                  }}
                >
                  {char}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={`app-container ${isTransitioning ? 'content-blur' : ''}`}>
        {children}
      </div>
    </>
  )
}
