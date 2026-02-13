// src/ReverseLayout.jsx
import React from 'react'

export default function ReverseLayout({ children, isTransitioning = false }) {
  // 转场动画用的符文环
  const transitionRunes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛟᛞ'.split('')

  return (
    <>
      {isTransitioning && (
        <div className="hallucination-overlay" style={{ 
            // 限制转场动画范围
            position: 'absolute', 
            top: 0, 
            left: 0, 
            width: '100%', 
            height: '100%', 
            overflow: 'hidden',
            pointerEvents: 'auto', // 阻挡点击
            zIndex: 999
        }}>
          <div className="magic-circle-container" style={{ 
              transform: 'scale(0.6)', // 缩小转场动画以适应悬浮窗
              top: '50%',
              left: '50%',
              position: 'absolute'
          }}>
             <div className="magic-circle outer"></div>
             <div className="magic-circle inner"></div>
             <div className="rune-ring">
              {transitionRunes.map((char, i) => (
                <span 
                  key={i} 
                  className="rune-char"
                  style={{ 
                    transform: `rotate(${i * (360 / transitionRunes.length)}deg) translateY(-25vmin)` // 减小半径
                  }}
                >
                  {char}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className={`app-container ${isTransitioning ? 'content-blur' : ''}`} style={{ width: '400px', height: '600px', overflow: 'hidden' }}>
        {children}
      </div>
    </>
  )
}
