// src/App.jsx
import React, { useState, useEffect, useRef } from 'react'
import ReverseLayout from './ReverseLayout'
import mqtt from 'mqtt'
import './styles/reverse1999.css'

// 随机生成神秘学风格的头像文字
const ICONS = ["✦", "⟡", "☾", "☼", "⚔", "⚖", "⚓", "⚡", "⚛", "⚜"]
const getAvatar = (name) => {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return ICONS[Math.abs(hash) % ICONS.length]
}

const MQTT_BROKER_URL = 'wss://broker.emqx.io:8084/mqtt'

export default function App() {
  const [page, setPage] = useState('lobby') 
  const [roomId, setRoomId] = useState('')
  const [username, setUsername] = useState('')
  const [isHost, setIsHost] = useState(false)
  
  // 检查是否为悬浮层模式
  const [isOverlay, setIsOverlay] = useState(false)

  // 转场动画状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [copyTip, setCopyTip] = useState('')

  // 播放器状态 (仅用于同步逻辑，不渲染)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(0) 
  // 标记是否正在处理 MQTT 指令，防止回环广播
  const isRemoteRef = useRef(false)
  
  // 成员列表
  const [members, setMembers] = useState(new Map())
  const clientRef = useRef(null) 

  // 初始化检查
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('overlay') === 'true') {
      setIsOverlay(true)
      document.body.style.backgroundColor = 'transparent'
      document.documentElement.style.backgroundColor = 'transparent'
    }
  }, [])

  // 监听来自父页面的视频事件 (Overlay Mode Only)
  useEffect(() => {
    if (!isOverlay) return

    const handleParentMessage = (event) => {
      const { type, payload } = event.data
      if (!type) return

      // 如果当前是由远程指令触发的，则不广播
      if (isRemoteRef.current) return

      switch (type) {
        case 'W2G_EVENT_PLAY':
          setPlaying(true)
          if (page === 'room') publishMessage({ type: 'PLAY', played: payload.currentTime }) // 注意：这里发的是 currentTime 而不是 percentage
          break
        case 'W2G_EVENT_PAUSE':
          setPlaying(false)
          if (page === 'room') publishMessage({ type: 'PAUSE', played: payload.currentTime })
          break
        case 'W2G_EVENT_SEEKED':
           if (page === 'room') publishMessage({ type: 'SEEK', to: payload.currentTime })
          break
        case 'W2G_EVENT_PROGRESS':
          setPlayed(payload.played)
          break
      }
    }

    window.addEventListener('message', handleParentMessage)
    return () => window.removeEventListener('message', handleParentMessage)
  }, [isOverlay, page, roomId]) // 依赖项

  // MQTT 连接
  useEffect(() => {
    if (page === 'room' && roomId && username) {
      // 初始化成员列表
      setMembers(prev => new Map(prev).set(username, { username, isHost, avatar: getAvatar(username) }))

      const client = mqtt.connect(MQTT_BROKER_URL, {
        clientId: `w2g_${Math.random().toString(16).slice(2, 8)}`,
        keepalive: 60,
        protocolId: 'MQTT',
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 1000,
        connectTimeout: 30 * 1000,
      })

      clientRef.current = client

      client.on('connect', () => {
        client.subscribe(`watch2gether/${roomId}`, (err) => {
          if (!err) {
            publishMessage({ type: 'GUEST_JOIN', isHost })
          }
        })
      })

      client.on('message', (topic, message) => {
        try {
          handleMqttMessage(JSON.parse(message.toString()))
        } catch (err) {
          console.error('[W2G] MQTT message parse failed:', err)
        }
      })

      return () => {
        client.end()
        clientRef.current = null
      }
    }
  }, [page, roomId, username, isHost])

  const publishMessage = (msg) => {
    if (clientRef.current && roomId) {
      clientRef.current.publish(`watch2gether/${roomId}`, JSON.stringify({
        ...msg,
        sender: username, 
        avatar: getAvatar(username),
        timestamp: Date.now()
      }))
    }
  }

  const handleCopyRoomId = async () => {
    if (!roomId) return
    try {
      await navigator.clipboard.writeText(roomId)
      setCopyTip('已复制')
    } catch (err) {
      console.error('[W2G] 复制房间号失败:', err)
      setCopyTip('复制失败')
    } finally {
      setTimeout(() => setCopyTip(''), 1200)
    }
  }

  const handleMqttMessage = (data) => {
    // 更新成员列表
    if (['GUEST_JOIN', 'PRESENCE'].includes(data.type) && data.sender) {
      setMembers(prev => {
        const newMap = new Map(prev)
        newMap.set(data.sender, { username: data.sender, isHost: data.isHost, avatar: data.avatar })
        return newMap
      })

      if (data.type === 'GUEST_JOIN' && data.sender !== username) {
        setTimeout(() => publishMessage({ type: 'PRESENCE', isHost }), Math.random() * 500)
      }
    }

    if (data.sender === username) return 

    // 标记为远程操作，防止回环
    isRemoteRef.current = true;
    setTimeout(() => { isRemoteRef.current = false }, 1000); // 1秒冷却

    // 处理同步指令 -> 控制本地网页播放器
    if (isOverlay) {
        switch (data.type) {
        case 'PLAY':
            setPlaying(true)
            sendCommandToParent('W2G_COMMAND_PLAY')
            // 如果有进度信息，顺便同步一下
            if (typeof data.played !== 'undefined') sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: true, isTime: true }) 
            break
        case 'PAUSE':
            setPlaying(false)
            sendCommandToParent('W2G_COMMAND_PAUSE')
            if (typeof data.played !== 'undefined') sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: false, isTime: true })
            break
        case 'SEEK':
            sendCommandToParent('W2G_COMMAND_SEEK', data.to) // data.to 是 currentTime
            break
        case 'SYNC_STATE': 
            // 收到权威状态同步
            if (!isHost) {
                if (typeof data.playing !== 'undefined') {
                    setPlaying(data.playing)
                    sendCommandToParent(data.playing ? 'W2G_COMMAND_PLAY' : 'W2G_COMMAND_PAUSE')
                }
                if (typeof data.played !== 'undefined') {
                    // data.played 在这里应该是 currentTime 或 percentage，需要统一
                    // 假设是 percentage
                    sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: data.playing })
                }
            }
            break
        }
    }

    // 房主同步状态给新人 (无需修改，只需要发送当前状态)
    if (data.type === 'GUEST_JOIN' && isHost && data.sender !== username) {
        // 请求父页面返回当前状态用于同步 (这里简化，假设 playing 和 played 状态是最新的)
        publishMessage({
            type: 'SYNC_STATE',
            playing: playing,
            played: played // 这个是 percentage
        })
    }
  }

  // 发送指令给父页面 (Content Script)
  const sendCommandToParent = (type, payload = null) => {
    window.parent.postMessage({ type, payload }, '*')
  }

  const handleMinimize = () => {
    sendCommandToParent('W2G_COMMAND_MINIMIZE')
  }

  const handleClose = () => {
    sendCommandToParent('W2G_COMMAND_CLOSE')
  }

  // 页面切换逻辑
  const switchPage = (targetPage) => {
    setIsTransitioning(true)
    setTimeout(() => {
      setPage(targetPage)
      setTimeout(() => {
        setIsTransitioning(false)
      }, 500) 
    }, 500) 
  }

  const handleCreateRoom = () => {
    if (!username.trim()) return
    const id = Math.random().toString(36).substring(2, 8).toUpperCase()
    setRoomId(id)
    setIsHost(true)
    switchPage('room')
  }

  const handleJoinRoom = () => {
    if (!username.trim() || !roomId.trim()) return
    setIsHost(false)
    switchPage('room')
  }

  const handleLeaveRoom = () => {
      if (clientRef.current) {
          clientRef.current.end();
      }
      setMembers(new Map());
      setRoomId('');
      setIsHost(false);
      switchPage('lobby');
  }

  // 渲染内容
  const renderContent = () => {
    if (page === 'lobby') {
      return (
        <div className="lobby-content fade-in" style={{ width: '100%', height: '100%', padding: '15px 25px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          
          <div style={{ position: 'absolute', top: '15px', right: '15px', zIndex: 30, display: 'flex', gap: '8px' }}>
             <button className="btn-icon" onClick={handleMinimize} style={{ background: 'transparent', border: 'none', color: '#cba168', fontSize: '1.2rem', cursor: 'pointer' }}>
                ━
             </button>
             <button className="btn-icon" onClick={handleClose} style={{ background: 'transparent', border: 'none', color: '#cba168', fontSize: '1.2rem', cursor: 'pointer' }}>
                ✕
             </button>
          </div>

          <h1 className="reverse-title" style={{ fontSize: '1.8rem', marginBottom: '5px' }}>连携：星辰占象</h1>
          <div className="reverse-subtitle" style={{ marginBottom: '30px' }}>Synergy: Astral Augury</div>
          
          <div className={`glass-panel ${isOverlay ? 'overlay-panel' : ''}`} style={{ width: '100%', padding: '20px 40px' }}>
            <input
              className="input-field"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="秘名 (Arcane Name)"
              style={{ marginBottom: '15px' }}
            />
            <input
              className="input-field"
              value={roomId}
              onChange={e => setRoomId(e.target.value.toUpperCase())}
              placeholder="幅频 (Frequency)"
              style={{ marginBottom: '25px' }}
            />
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', justifyContent: 'center' }}>
              <button className="btn-primary" onClick={handleCreateRoom} disabled={!username.trim()} style={{ width: '100%' }}>
                主导 (Host)
              </button>
              <button className="btn-primary" onClick={handleJoinRoom} disabled={!username.trim() || !roomId.trim()} style={{ width: '100%' }}>
                感知 (Join)
              </button>
            </div>
          </div>
        </div>
      )
    }

    // Room 界面
    return (
      <div className="room-grid fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '10px' }}>
        
        {/* 1. 顶部信息栏 */}
        <div style={{ 
            padding: '15px', 
            borderBottom: '1px solid rgba(203, 161, 104, 0.3)', 
            marginBottom: '10px',
            background: 'rgba(0,0,0,0.4)',
            borderRadius: '8px',
            position: 'relative'
        }}>
            <div style={{ position: 'relative', right: '-300px', zIndex: 30, display: 'flex', gap: '8px' }}>
                <button className="btn-icon" onClick={handleMinimize} style={{ background: 'transparent', border: 'none', color: '#cba168', fontSize: '1.2rem', cursor: 'pointer' }}>
                    ━
                </button>
                <button className="btn-icon" onClick={handleClose} style={{ background: 'transparent', border: 'none', color: '#cba168', fontSize: '1.2rem', cursor: 'pointer' }}>
                    ✕
                </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                <span style={{ color: '#cba168', fontWeight: 'bold' }}>幅频 (Frequency)</span>
                <span
                  style={{ fontFamily: 'monospace', fontSize: '1.2rem' ,color: '#cba168', cursor: 'pointer' }}
                  title="点击复制幅频"
                  onClick={handleCopyRoomId}
                >
                  {roomId}{copyTip ? ` (${copyTip})` : ''}
                </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#888' }}>秘名 (User)</span>
                <span>{username} </span>
            </div>
        </div>

        {/* 2. 成员列表 */}
        <div className="sidebar" style={{ flex: '1 1 auto', overflowY: 'auto', marginBottom: '10px', background: 'rgba(0,0,0,0.2)', padding: '5px', borderRadius: '8px' }}>
          <div className="sidebar-header" style={{ fontSize: '0.9rem', padding: '5px 8px', marginBottom: '5px' }}>
            众仪 ({members.size})
          </div>
          <div className="member-list" style={{ padding: '0 5px' }}>
            {Array.from(members.values()).map(m => (
              <div key={m.username} className="member-card" style={{ padding: '8px', marginBottom: '5px' }}>
                <div className="avatar-icon" style={{ width: '30px', height: '30px', fontSize: '1rem' }}>{m.avatar}</div>
                <div>
                  <div style={{ color: '#e6e6e6', fontSize: '0.9rem' }}>{m.username}</div>
                  <div style={{ fontSize: '0.7rem', color: '#cba168' }}>{m.isHost ? '主导者' : '观察者'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 3. 底部退出按钮 */}
        <div style={{ flex: '0 0 auto', marginTop: 'auto' }}>
            <button 
                className="btn-primary" 
                onClick={handleLeaveRoom}
                style={{ width: '100%', padding: '12px', background: 'rgba(255, 50, 50, 0.2)', borderColor: '#ff4444' }}
            >
                断开连接 (Disconnect)
            </button>
        </div>
      </div>
    )
  }

  // 包装器
  return (
    <ReverseLayout isTransitioning={isTransitioning}>
      <div className={`app-container ${isTransitioning ? 'transitioning' : ''}`} style={{ width: '100%', height: '100%', overflow: 'hidden', background: isOverlay ? 'rgba(20, 20, 20, 0.95)' : 'transparent', borderRadius: '12px' }}>
          {renderContent()}
      </div>
    </ReverseLayout>
  )
}
