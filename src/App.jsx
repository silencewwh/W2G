// src/App.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react'
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

// 生产默认使用自建 Mosquitto 的 WSS 入口（ImmortalWrt: listener 9001 + protocol websockets）
// 注意：Mosquitto 常见路径是 `/`，不像部分 broker（如 EMQX）会使用 `/mqtt`。
const MQTT_BROKER_URL = 'wss://chihuaiyu.asia:9001'
const MQTT_CONFIG = {
  brokerUrl: import.meta.env.VITE_MQTT_BROKER_URL || MQTT_BROKER_URL,
  localFallbackUrl: import.meta.env.VITE_MQTT_LOCAL_WS_FALLBACK_URL || 'ws://localhost:9002/mqtt',
  rejectUnauthorized: (import.meta.env.VITE_MQTT_REJECT_UNAUTHORIZED || 'true') === 'true',
  caPem: import.meta.env.VITE_MQTT_CA_PEM || ''
}
const CONTROL_GRACE_MS = Math.max(0, Number(import.meta.env.VITE_W2G_CONTROL_GRACE_MS) || 4500)
const CONTROL_OWNER_MS = Math.max(CONTROL_GRACE_MS, Number(import.meta.env.VITE_W2G_CONTROL_OWNER_MS) || 9000)

export default function App() {
  const sessionIdRef = useRef(`w2g_${Math.random().toString(16).slice(2, 10)}`)
  const [page, setPage] = useState('lobby')
  const [roomId, setRoomId] = useState('')
  const [username, setUsername] = useState('')
  const [isHost, setIsHost] = useState(false)
  
  // 检查是否为悬浮层模式
  const [isOverlay, setIsOverlay] = useState(false)

  // 转场动画状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [copyTip, setCopyTip] = useState('')

  // MQTT 连接状态
  const [connectionStatus, setConnectionStatus] = useState('disconnected') // disconnected, connecting, connected, error
  const [errorMessage, setErrorMessage] = useState('')

  // 播放器状态 (仅用于同步逻辑，不渲染)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(0)
  const playingRef = useRef(false)
  const playedRef = useRef(0)
  const latestPageStateRef = useRef(null)
  const localControlUntilRef = useRef(0)
  const controlOwnerSessionRef = useRef(sessionIdRef.current)
  const controlOwnerUntilRef = useRef(0)
  // 标记是否正在处理 MQTT 指令，防止回环广播
  const isRemoteRef = useRef(false)
  
  // 成员列表
  const [members, setMembers] = useState(new Map())
  const clientRef = useRef(null)

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    playedRef.current = played
  }, [played])

  // 发送指令给父页面 (Content Script)
  const sendCommandToParent = useCallback((type, payload = null) => {
    window.parent.postMessage({ type, payload }, '*')
  }, [])

  const markLocalAuthority = useCallback(() => {
    const now = Date.now()
    localControlUntilRef.current = now + CONTROL_GRACE_MS
    controlOwnerSessionRef.current = sessionIdRef.current
    controlOwnerUntilRef.current = now + CONTROL_OWNER_MS
  }, [])

  const publishMessage = useCallback((msg) => {
    if (clientRef.current && roomId) {
      clientRef.current.publish(`watch2gether/${roomId}`, JSON.stringify({
        ...msg,
        sessionId: sessionIdRef.current,
        sender: username,
        avatar: getAvatar(username),
        timestamp: Date.now()
      }))
    }
  }, [roomId, username])

  const handleMqttMessage = useCallback((data) => {
    if (!data || typeof data !== 'object') return
    const memberKey = data.sessionId || data.sender
    const isSelfMessage = data.sessionId
      ? data.sessionId === sessionIdRef.current
      : data.sender === username

    // 更新成员列表
    if (['GUEST_JOIN', 'PRESENCE'].includes(data.type) && data.sender && memberKey) {
      setMembers(prev => {
        const newMap = new Map(prev)
        newMap.set(memberKey, {
          sessionId: data.sessionId,
          username: data.sender,
          isHost: data.isHost,
          avatar: data.avatar
        })
        return newMap
      })

      if (data.type === 'GUEST_JOIN' && !isSelfMessage) {
        setTimeout(() => publishMessage({ type: 'PRESENCE', isHost }), Math.random() * 500)
      }
    }

    if (isSelfMessage) return

    // 标记为远程操作，防止回环
    isRemoteRef.current = true
    setTimeout(() => { isRemoteRef.current = false }, 1000)

    // 处理同步指令 -> 控制本地网页播放器
    if (isOverlay) {
      if (['PLAY', 'PAUSE', 'SEEK', 'SYNC_STATE', 'PAGE_STATE'].includes(data.type) && Date.now() < localControlUntilRef.current) {
        return
      }

      if (['PLAY', 'PAUSE', 'SEEK', 'PAGE_STATE', 'BUFFERING_START', 'BUFFERING_END'].includes(data.type) && data.sessionId) {
        controlOwnerSessionRef.current = data.sessionId
        controlOwnerUntilRef.current = Date.now() + CONTROL_OWNER_MS
      }

      switch (data.type) {
        case 'PLAY':
          setPlaying(true)
          sendCommandToParent('W2G_COMMAND_PLAY')
          if (typeof data.played !== 'undefined') sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: true, isTime: true })
          break
        case 'PAUSE':
          setPlaying(false)
          sendCommandToParent('W2G_COMMAND_PAUSE')
          if (typeof data.played !== 'undefined') sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: false, isTime: true })
          break
        case 'SEEK':
          sendCommandToParent('W2G_COMMAND_SEEK', data.to)
          break
        case 'SYNC_STATE':
          if (typeof data.playing !== 'undefined') {
            setPlaying(data.playing)
            sendCommandToParent(data.playing ? 'W2G_COMMAND_PLAY' : 'W2G_COMMAND_PAUSE')
          }
          if (typeof data.played !== 'undefined') {
            sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: data.playing })
          }
          break
        case 'PAGE_STATE':
          if (data.state) {
            latestPageStateRef.current = data.state
            sendCommandToParent('W2G_COMMAND_PAGE_STATE', data.state)
          }
          break
        case 'BUFFERING_START':
          setPlaying(false)
          sendCommandToParent('W2G_COMMAND_PAUSE')
          break
        case 'BUFFERING_END':
          if (typeof data.playing !== 'undefined') {
            setPlaying(data.playing)
            sendCommandToParent(data.playing ? 'W2G_COMMAND_PLAY' : 'W2G_COMMAND_PAUSE')
          }
          if (typeof data.played !== 'undefined') {
            sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: data.playing, isTime: true })
          }
          break
      }
    }

    // 房主同步状态给新人
    if (data.type === 'GUEST_JOIN' && !isSelfMessage && isOverlay) {
      publishMessage({
        type: 'SYNC_STATE',
        playing: playingRef.current,
        played: playedRef.current
      })
      if (latestPageStateRef.current) {
        publishMessage({
          type: 'PAGE_STATE',
          state: latestPageStateRef.current
        })
      }
    }
  }, [isOverlay, publishMessage, sendCommandToParent, username])

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
      if (!event.data || typeof event.data !== 'object') return
      const { type, payload } = event.data
      if (!type) return

      // 如果当前是由远程指令触发的，则不广播
      if (isRemoteRef.current) return

      switch (type) {
        case 'W2G_EVENT_PLAY':
          markLocalAuthority()
          setPlaying(true)
          if (page === 'room') publishMessage({ type: 'PLAY', played: payload.currentTime }) // 注意：这里发的是 currentTime 而不是 percentage
          break
        case 'W2G_EVENT_PAUSE':
          markLocalAuthority()
          setPlaying(false)
          if (page === 'room') publishMessage({ type: 'PAUSE', played: payload.currentTime })
          break
        case 'W2G_EVENT_SEEKED':
           markLocalAuthority()
           if (page === 'room') publishMessage({ type: 'SEEK', to: payload.currentTime })
          break
        case 'W2G_EVENT_PROGRESS':
          setPlayed(payload.played)
          break
        case 'W2G_EVENT_PAGE_STATE':
          markLocalAuthority()
          latestPageStateRef.current = payload
          if (page === 'room') publishMessage({ type: 'PAGE_STATE', state: payload })
          break
        case 'W2G_EVENT_BUFFERING_START':
          markLocalAuthority()
          if (page === 'room') publishMessage({ type: 'BUFFERING_START', played: payload?.currentTime })
          break
        case 'W2G_EVENT_BUFFERING_END':
          markLocalAuthority()
          if (page === 'room') publishMessage({
            type: 'BUFFERING_END',
            played: payload?.currentTime,
            playing: payload?.playing
          })
          break
        case 'W2G_COPY_RESULT':
          setCopyTip(payload?.ok ? '已复制' : '复制失败')
          setTimeout(() => setCopyTip(''), 1200)
          break
      }
    }

    window.addEventListener('message', handleParentMessage)
    return () => window.removeEventListener('message', handleParentMessage)
  }, [isOverlay, markLocalAuthority, page, publishMessage, roomId]) // 依赖项

  // MQTT 连接
  useEffect(() => {
    if (page === 'room' && roomId && username) {
      // 初始化成员列表
      setMembers(prev => new Map(prev).set(sessionIdRef.current, {
        sessionId: sessionIdRef.current,
        username,
        isHost,
        avatar: getAvatar(username)
      }))

      setConnectionStatus('connecting')
      setErrorMessage('')

      let client = null
      let connectedOnce = false
      let fallbackTried = false

      const shouldTryLocalFallback =
        /^wss:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(MQTT_CONFIG.brokerUrl)

      const createClient = (brokerUrl) => {
        const connectionOptions = {
          clientId: `w2g_${Math.random().toString(16).slice(2, 8)}`,
          keepalive: 60,
          protocolId: 'MQTT',
          protocolVersion: 4,
          clean: true,
          reconnectPeriod: 3000,
          connectTimeout: 10 * 1000,
          rejectUnauthorized: MQTT_CONFIG.rejectUnauthorized
        }
        if (MQTT_CONFIG.caPem) connectionOptions.ca = MQTT_CONFIG.caPem
        return mqtt.connect(brokerUrl, connectionOptions)
      }

      try {
        client = createClient(MQTT_CONFIG.brokerUrl)
      } catch (err) {
        console.error('[W2G] MQTT init failed:', err)
        setConnectionStatus('error')
        setErrorMessage(`MQTT 初始化失败: ${err?.message || '未知错误'} (地址: ${MQTT_CONFIG.brokerUrl})`)
        return
      }

      clientRef.current = client

      client.on('connect', () => {
        connectedOnce = true
        console.log('[W2G] MQTT Connected')
        setConnectionStatus('connected')
        setErrorMessage('')
        client.subscribe(`watch2gether/${roomId}`, (err) => {
          if (!err) {
            publishMessage({ type: 'GUEST_JOIN', isHost })
          } else {
            console.error('[W2G] Subscribe error:', err)
            setErrorMessage('订阅房间失败')
          }
        })
      })

      client.on('error', (err) => {
        console.error('[W2G] MQTT Error:', err)
        setConnectionStatus('error')
        setErrorMessage(`连接错误: ${err.message}`)
      })

      client.on('offline', () => {
        console.log('[W2G] MQTT Offline')
        setConnectionStatus(prev => (prev === 'error' ? prev : 'connecting'))
      })

      client.on('close', () => {
        console.log('[W2G] MQTT Closed')
        if (!connectedOnce && shouldTryLocalFallback && !fallbackTried) {
          fallbackTried = true
          console.warn(`[W2G] WSS connect failed, fallback to ${MQTT_CONFIG.localFallbackUrl}`)
          setConnectionStatus('connecting')
          client.removeAllListeners()
          clientRef.current = createClient(MQTT_CONFIG.localFallbackUrl)
          client = clientRef.current

          client.on('connect', () => {
            connectedOnce = true
            console.log('[W2G] MQTT Connected (fallback)')
            setConnectionStatus('connected')
            setErrorMessage('')
            client.subscribe(`watch2gether/${roomId}`, (err) => {
              if (!err) {
                publishMessage({ type: 'GUEST_JOIN', isHost })
              } else {
                console.error('[W2G] Subscribe error:', err)
                setErrorMessage('订阅房间失败')
              }
            })
          })

          client.on('error', (err) => {
            console.error('[W2G] MQTT Error (fallback):', err)
            setConnectionStatus('error')
            setErrorMessage(`连接错误: ${err.message}`)
          })

          client.on('offline', () => {
            console.log('[W2G] MQTT Offline (fallback)')
            setConnectionStatus(prev => (prev === 'error' ? prev : 'connecting'))
          })

          client.on('close', () => {
            console.log('[W2G] MQTT Closed (fallback)')
            setConnectionStatus('disconnected')
          })

          client.on('message', (topic, message) => {
            try {
              handleMqttMessage(JSON.parse(message.toString()))
            } catch (err) {
              console.error('[W2G] MQTT message parse failed:', err)
            }
          })
          return
        }
        setConnectionStatus('disconnected')
      })

      client.on('message', (topic, message) => {
        try {
          handleMqttMessage(JSON.parse(message.toString()))
        } catch (err) {
          console.error('[W2G] MQTT message parse failed:', err)
        }
      })

      return () => {
        console.log('[W2G] Disconnecting MQTT')
        client.end()
        clientRef.current = null
        setConnectionStatus('disconnected')
      }
    }
  }, [handleMqttMessage, isHost, page, publishMessage, roomId, username])

  useEffect(() => {
    if (!(page === 'room' && isOverlay && connectionStatus === 'connected')) return

    const timer = setInterval(() => {
      if (isRemoteRef.current) return
      const now = Date.now()
      const isCurrentOwner = controlOwnerSessionRef.current === sessionIdRef.current
      const ownerValid = now < controlOwnerUntilRef.current
      if (!(isCurrentOwner && ownerValid)) return
      publishMessage({
        type: 'SYNC_STATE',
        playing: playingRef.current,
        played: playedRef.current
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [connectionStatus, isOverlay, page, publishMessage])

  const handleCopyRoomId = async () => {
    if (!roomId) return
    try {
      await navigator.clipboard.writeText(roomId)
      setCopyTip('已复制')
    } catch (err) {
      console.error('[W2G] 复制房间号失败:', err)
      sendCommandToParent('W2G_COPY_TEXT', roomId)
      setCopyTip('复制中...')
    } finally {
      setTimeout(() => {
        setCopyTip(prev => (prev === '复制中...' ? '' : prev))
      }, 1500)
    }
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
    const normalizedRoomId = roomId.trim().toUpperCase()
    if (!username.trim() || !normalizedRoomId) return
    setRoomId(normalizedRoomId)
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

            {connectionStatus !== 'connected' && (
                <div style={{
                    marginBottom: '10px',
                    padding: '5px',
                    background: 'rgba(255, 50, 50, 0.1)',
                    border: '1px solid rgba(255, 50, 50, 0.3)',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    color: '#ff6666',
                    textAlign: 'center'
                }}>
                    {connectionStatus === 'connecting' ? '正在建立连接...' : `连接失败: ${errorMessage || '未知错误'}`}
                </div>
            )}

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
            
            {/* 连接状态提示 */}
            {connectionStatus !== 'connected' && (
                <div style={{
                    marginTop: '10px',
                    padding: '5px',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    textAlign: 'center',
                    background: connectionStatus === 'error' ? 'rgba(255, 50, 50, 0.2)' : 'rgba(203, 161, 104, 0.2)',
                    color: connectionStatus === 'error' ? '#ff4444' : '#cba168'
                }}>
                    {connectionStatus === 'connecting' ? '正在建立连接...' : errorMessage || '连接断开'}
                </div>
            )}
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
