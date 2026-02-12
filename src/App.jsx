// src/App.jsx
import React, { useState, useEffect, useRef } from 'react'
import ReverseLayout from './ReverseLayout'
import ReactPlayer from 'react-player'
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
  
  // 转场动画状态
  const [isTransitioning, setIsTransitioning] = useState(false)

  // 播放器状态
  const [videoUrl, setVideoUrl] = useState('') 
  const [inputUrl, setInputUrl] = useState('') 
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(0) 
  const [seeking, setSeeking] = useState(false)
  
  // 成员列表
  const [members, setMembers] = useState(new Map())

  const playerRef = useRef(null)
  const clientRef = useRef(null) 

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
        handleMqttMessage(JSON.parse(message.toString()))
      })

      return () => client.end()
    }
  }, [page, roomId])

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

  const handleMqttMessage = (data) => {
    // 更新成员列表
    if (['GUEST_JOIN', 'PRESENCE'].includes(data.type) && data.sender) {
      setMembers(prev => {
        const newMap = new Map(prev)
        newMap.set(data.sender, { username: data.sender, isHost: data.isHost, avatar: data.avatar })
        return newMap
      })

      // 回复 PRESENCE
      if (data.type === 'GUEST_JOIN' && data.sender !== username) {
        setTimeout(() => publishMessage({ type: 'PRESENCE', isHost }), Math.random() * 500)
      }
    }

    if (data.sender === username) return 

    switch (data.type) {
      case 'SET_URL':
        setVideoUrl(data.url)
        setPlaying(false)
        setPlayed(0)
        break
      case 'PLAY':
        setPlaying(true)
        if (typeof data.played !== 'undefined' && playerRef.current) {
          const diff = Math.abs(playerRef.current.getCurrentTime() - (data.played * playerRef.current.getDuration()))
          if (diff > 2) playerRef.current.seekTo(data.played, 'fraction')
        }
        break
      case 'PAUSE':
        setPlaying(false)
        if (typeof data.played !== 'undefined' && playerRef.current) {
           playerRef.current.seekTo(data.played, 'fraction')
           setPlayed(data.played)
        }
        break
      case 'SEEK':
        if (playerRef.current) {
          playerRef.current.seekTo(data.to, 'fraction')
          setPlayed(data.to)
        }
        break
      case 'SYNC_STATE': 
        if (!isHost) {
          if (data.url && data.url !== videoUrl) setVideoUrl(data.url)
          if (typeof data.playing !== 'undefined') setPlaying(data.playing)
          if (typeof data.played !== 'undefined' && playerRef.current) {
             const duration = playerRef.current.getDuration()
             if (duration && Math.abs(playerRef.current.getCurrentTime() - (data.played * duration)) > 1) {
               playerRef.current.seekTo(data.played, 'fraction')
             }
          }
        }
        break
    }

    // 房主同步状态给新人
    if (data.type === 'GUEST_JOIN' && isHost && data.sender !== username) {
      const currentProgress = playerRef.current ? (playerRef.current.getCurrentTime() / playerRef.current.getDuration()) : 0
      publishMessage({
        type: 'SYNC_STATE',
        url: videoUrl,
        playing: playing,
        played: currentProgress || 0
      })
    }
  }

  // 播放器回调
  const handlePlay = () => {
    setPlaying(true)
    publishMessage({ type: 'PLAY', played: played })
  }

  const handlePause = () => {
    setPlaying(false)
    publishMessage({ type: 'PAUSE', played: played })
  }

  const handleSeekChange = (e) => setPlayed(parseFloat(e.target.value))
  const handleSeekMouseDown = () => setSeeking(true)
  const handleSeekMouseUp = (e) => {
    setSeeking(false)
    const to = parseFloat(e.target.value)
    if (playerRef.current) playerRef.current.seekTo(to, 'fraction')
    publishMessage({ type: 'SEEK', to: to })
  }
  const handleProgress = (state) => { if (!seeking) setPlayed(state.played) }
  
  const handleUrlSubmit = () => {
    if (!isHost) return
    if (inputUrl && inputUrl !== videoUrl) {
      setVideoUrl(inputUrl)
      setPlayed(0)
      setPlaying(false)
      publishMessage({ type: 'SET_URL', url: inputUrl })
    }
  }

  // 页面切换逻辑（含动画）
  const switchPage = (targetPage) => {
    setIsTransitioning(true)
    setTimeout(() => {
      setPage(targetPage)
      // 这里的 setTimeout 时间应该与 CSS 动画时间匹配
      setTimeout(() => {
        setIsTransitioning(false)
      }, 500) // 结束动画
    }, 500) // 进场动画时间
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

  // 渲染内容
  const renderContent = () => {
    if (page === 'lobby') {
      return (
        <div className="lobby-content fade-in">
          <h1 className="reverse-title">连携：星辰占象</h1>
          <div className="reverse-subtitle">Synergy: Astral Augury</div>
          <div className="glass-panel">
            <div className="corner-decor corner-tl"></div>
            <div className="corner-decor corner-tr"></div>
            <div className="corner-decor corner-bl"></div>
            <div className="corner-decor corner-br"></div>
            
            <input
              className="input-field"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="秘名 (Arcane Name)"
            />
            <input
              className="input-field"
              value={roomId}
              onChange={e => setRoomId(e.target.value.toUpperCase())}
              placeholder="幅频 (Frequency)"
            />
            
            <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', marginTop: '30px' }}>
              <button className="btn-primary" onClick={handleJoinRoom} disabled={!username.trim() || !roomId.trim()}>
                感知
              </button>
              <button className="btn-primary" onClick={handleCreateRoom} disabled={!username.trim()}>
                主导
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="room-grid fade-in">
        {/* 左侧：播放器区域 */}
        <div className="player-frame">
          <div style={{ padding: '10px 20px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', color: '#cba168' }}>
            <span>频率: {roomId}</span>
            <span>代号: {username}</span>
          </div>
          
          <div className="player-wrapper">
            {videoUrl ? (
              <ReactPlayer
                ref={playerRef}
                url={videoUrl}
                width="100%"
                height="100%"
                playing={playing}
                controls={false}
                onPlay={handlePlay}
                onPause={handlePause}
                onProgress={handleProgress}
                muted={false} 
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', flexDirection: 'column' }}>
                <div style={{ fontSize: '3rem', opacity: 0.5 }}>✦</div>
                <div style={{ marginTop: '10px' }}>等待影像输入...</div>
              </div>
            )}
          </div>

          <div className="control-bar">
            <button 
              className="btn-primary" 
              style={{ padding: '5px 15px', fontSize: '0.8rem', minWidth: '60px', marginRight: '10px' }}
              onClick={() => switchPage('lobby')}
            >
              ← 返回
            </button>

            <button 
              className="btn-primary" 
              style={{ padding: '5px 15px', fontSize: '0.8rem', minWidth: '80px' }}
              onClick={() => playing ? handlePause() : handlePlay()}
            >
              {playing ? '暂停' : '播放'}
            </button>
            
            <input
              type='range' min={0} max={0.999999} step='any'
              value={played}
              onMouseDown={handleSeekMouseDown}
              onChange={handleSeekChange}
              onMouseUp={handleSeekMouseUp}
              className="magic-slider"
            />
            
            {isHost && (
              <div style={{ display: 'flex', gap: '10px' }}>
                <input 
                  className="input-field" 
                  style={{ width: '200px', fontSize: '0.9rem', margin: 0, padding: '5px' }}
                  placeholder="输入影像链接..." 
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                />
                <button 
                  className="btn-primary" 
                  style={{ padding: '5px 10px', fontSize: '0.8rem' }}
                  onClick={handleUrlSubmit}
                >
                  投射
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：成员列表 */}
        <div className="sidebar">
          <div className="sidebar-header">
            行动小队 ({members.size})
          </div>
          <div className="member-list">
            {Array.from(members.values()).map(m => (
              <div key={m.username} className="member-card">
                <div className="avatar-icon">{m.avatar}</div>
                <div>
                  <div style={{ color: '#e6e6e6' }}>{m.username}</div>
                  <div style={{ fontSize: '0.8rem', color: '#cba168' }}>{m.isHost ? '队长' : '队员'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <ReverseLayout enableRunes={page === 'lobby'} isTransitioning={isTransitioning}>
      {renderContent()}
    </ReverseLayout>
  )
}