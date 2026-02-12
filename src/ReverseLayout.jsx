// src/ReverseLayout.jsx
import React, { useEffect } from 'react'

export default function ReverseLayout({ children, enableRunes = false, isTransitioning = false }) {
  useEffect(() => {
    // 只有在需要符文的时候才启动
    if (!enableRunes) return

    // 真·卢恩符文字符
    const RUNES = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ', 'ᚷ', 'ᚹ']

    // 当前所有符文粒子
    const runes = []

    // 参数配置
    const NUM_RUNES = 35            // 屏幕上保持的符文数量
    const BASE_SPEED = 0.2          // 初始基础速度
    const NOISE = 0.05              // 漂浮噪声
    const DAMPING = 0.96            // 阻尼

    const FADE_IN = 800             // 淡入时间（ms）
    const FADE_OUT = 1200           // 淡出时间（ms）
    const LIFE_MIN = 4000           // 最短生命周期
    const LIFE_MAX = 8000           // 最长生命周期

    // 点击吸引脉冲参数
    const PULSE_FORCE = 0.35        // 吸引力度
    const PULSE_DURATION = 600      // 吸引持续时间（ms）
    const PULSE_RADIUS = 300        // 有效吸引半径

    let pulseTargetX = null
    let pulseTargetY = null
    let pulseEndTime = 0
    let rafId = null

    const randomLife = () => LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN)

    // 生成一个新的符文
    const spawnRune = () => {
      const w = window.innerWidth
      const h = window.innerHeight

      const x = Math.random() * w
      const y = Math.random() * h

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

        x += vx
        y += vy

        // 简单的边界处理：如果飘出太远就直接结束生命，或者让它自然消失
        // 这里不做特殊边界反弹，让它自然生灭更像魔法背景

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
  }, [enableRunes])

  return (
    <>
      {/* 暴雨层 */}
      <div className="storm-layer"></div>
      
      {/* 幻觉转场层 */}
      {isTransitioning && <div className="hallucination-overlay"></div>}

      {/* 主应用容器 */}
      <div className={`app-container ${isTransitioning ? 'content-blur' : ''}`}>
        {children}
      </div>
    </>
  )
}
