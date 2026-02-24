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

const SYNC_BROADCAST_INTERVAL_MS = Math.max(250, Number(import.meta.env.VITE_W2G_SYNC_BROADCAST_INTERVAL_MS) || 1000)
const SEEN_EVENT_IDS_MAX = 200

const roomBaseTopic = (roomId) => `watch2gether/${roomId}`
const roomEventTopic = (roomId) => `${roomBaseTopic(roomId)}/event`
const roomStateTopic = (roomId) => `${roomBaseTopic(roomId)}/state`
const roomPresencePrefix = (roomId) => `${roomBaseTopic(roomId)}/presence/`

export default function App() {
  const sessionIdRef = useRef(`w2g_${Math.random().toString(16).slice(2, 10)}`)
  const [page, setPage] = useState('lobby')
  const [roomId, setRoomId] = useState('')
  const [username, setUsername] = useState('')
  const [isHost, setIsHost] = useState(false)
  
  // 检查是否为悬浮层模式
  const [isOverlay, setIsOverlay] = useState(false)
  const [targetTabId, setTargetTabId] = useState(null)
  const [controllableTabs, setControllableTabs] = useState([])

  // 转场动画状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [copyTip, setCopyTip] = useState('')

  // MQTT 连接状态
  const [connectionStatus, setConnectionStatus] = useState('disconnected') // disconnected, connecting, connected, error
  const [errorMessage, setErrorMessage] = useState('')

  // 播放器状态 (仅用于同步逻辑，不渲染)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(0)
  const [progress, setProgress] = useState(0)
  const playingRef = useRef(false)
  const playedRef = useRef(0)
  const progressRef = useRef(0)
  const latestPageStateRef = useRef(null)
  const localControlUntilRef = useRef(0)
  const controlOwnerSessionRef = useRef(sessionIdRef.current)
  const controlOwnerUntilRef = useRef(0)
  // 标记是否正在处理 MQTT 指令，防止回环广播
  const isRemoteRef = useRef(false)

  const eventSeqRef = useRef(0)
  const lastAppliedStateRef = useRef({ ownerSessionId: '', v: 0 })
  const localStateVersionRef = useRef(0)
  const seenEventIdsRef = useRef({ set: new Set(), queue: [] })
  const lastLockUpdateMsRef = useRef(0)
  
  // 成员列表
  const [members, setMembers] = useState(new Map())
  const [hostPageState, setHostPageState] = useState(null)
  const clientRef = useRef(null)

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    playedRef.current = played
  }, [played])

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  const getActiveTabId = useCallback(async () => {
    if (typeof targetTabId === 'number' && targetTabId > 0) return targetTabId
    const chromeApi = globalThis.chrome
    if (!chromeApi?.tabs?.query) return null
    // Standalone window is not the target web page window; prefer lastFocusedWindow as a fallback.
    const tabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
    return tabs && tabs[0] ? tabs[0].id : null
  }, [targetTabId])

  const refreshControllableTabs = useCallback(async () => {
    if (isOverlay) return
    const chromeApi = globalThis.chrome
    if (!chromeApi?.tabs?.query) return
    try {
      const tabs = await chromeApi.tabs.query({})
      const filtered = (tabs || [])
        .filter(t => typeof t?.id === 'number')
        .filter(t => typeof t?.url === 'string' && /^https?:\/\//i.test(t.url))
        .map(t => ({
          id: t.id,
          title: t.title || '',
          url: t.url || '',
          windowId: t.windowId,
          index: t.index
        }))
        .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))

      setControllableTabs(filtered)

      // If no target selected yet, pick the first available tab.
      if (!(typeof targetTabId === 'number' && targetTabId > 0) && filtered.length > 0) {
        setTargetTabId(filtered[0].id)
        const sp = new URLSearchParams(window.location.search)
        sp.set('tabId', String(filtered[0].id))
        window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`)
      }
    } catch (err) {
      console.warn('[W2G] refreshControllableTabs failed:', err?.message || err)
    }
  }, [isOverlay, targetTabId])

  // 发送指令给父页面 (Overlay) 或目标网页 Content Script (Standalone Window)
  const sendCommandToParent = useCallback(async (type, payload = null) => {
    if (isOverlay) {
      window.parent.postMessage({ type, payload }, '*')
      return
    }

    const tabId = await getActiveTabId()
    if (!tabId) return
    try {
      const chromeApi = globalThis.chrome
      await chromeApi?.tabs?.sendMessage?.(tabId, { action: 'W2G_PANEL_COMMAND', type, payload })
    } catch (err) {
      console.warn('[W2G] sendMessage to content script failed:', err?.message || err)
    }
  }, [getActiveTabId, isOverlay])

  const rememberEventId = useCallback((eventId) => {
    if (!eventId) return false
    const store = seenEventIdsRef.current
    if (store.set.has(eventId)) return true
    store.set.add(eventId)
    store.queue.push(eventId)
    while (store.queue.length > SEEN_EVENT_IDS_MAX) {
      const oldest = store.queue.shift()
      if (oldest) store.set.delete(oldest)
    }
    return false
  }, [])

  const nextEventId = useCallback(() => {
    eventSeqRef.current += 1
    return `${sessionIdRef.current}-${eventSeqRef.current}`
  }, [])

  const nextLocalStateVersion = useCallback(() => {
    const now = Date.now()
    const prev = localStateVersionRef.current
    const next = now > prev ? now : prev + 1
    localStateVersionRef.current = next
    return next
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

  const publishEvent = useCallback((msg) => {
    if (!clientRef.current || !roomId) return
    const isControlEvent = ['PLAY', 'PAUSE', 'SEEK', 'PAGE_STATE', 'BUFFERING_START', 'BUFFERING_END'].includes(msg?.type)
    const now = Date.now()
    const payload = {
      ...msg,
      eventId: msg.eventId || nextEventId(),
      ...(isControlEvent
        ? {
            ownerSessionId: controlOwnerSessionRef.current,
            ownerUntilMs: controlOwnerUntilRef.current,
            lockAtMs: now
          }
        : {}),
      isHost,
      sessionId: sessionIdRef.current,
      sender: username,
      avatar: getAvatar(username),
      timestamp: now
    }
    clientRef.current.publish(roomEventTopic(roomId), JSON.stringify(payload), { qos: 0, retain: false })
    // legacy compatibility
    publishMessage(payload)
  }, [isHost, nextEventId, publishMessage, roomId, username])

  const publishState = useCallback((snapshot) => {
    if (!clientRef.current || !roomId) return
    clientRef.current.publish(roomStateTopic(roomId), JSON.stringify(snapshot), { qos: 1, retain: true })
  }, [roomId])

  const publishPresence = useCallback((status) => {
    if (!clientRef.current || !roomId) return
    const presenceTopic = `${roomPresencePrefix(roomId)}${sessionIdRef.current}`
    const payload = {
      type: 'PRESENCE',
      status,
      sessionId: sessionIdRef.current,
      sender: username,
      avatar: getAvatar(username),
      isHost,
      timestamp: Date.now()
    }
    clientRef.current.publish(presenceTopic, JSON.stringify(payload), { qos: 1, retain: true })
  }, [isHost, roomId, username])

  const publishStateSnapshot = useCallback((reason = 'periodic') => {
    if (!isOverlay) return
    if (!roomId || !clientRef.current) return
    const now = Date.now()

    const ownerSessionId = controlOwnerSessionRef.current
    const ownerUntilMs = controlOwnerUntilRef.current
    const isOwner = ownerSessionId === sessionIdRef.current && now < ownerUntilMs
    if (!isOwner) return

    const v = nextLocalStateVersion()
    const snapshot = {
      type: 'STATE',
      v,
      reason,
      ownerSessionId,
      ownerUntilMs,
      playing: playingRef.current,
      positionSec: playedRef.current,
      progress: progressRef.current,
      playbackRate: 1,
      pageState: isHost ? latestPageStateRef.current : null,
      pageOwnerSessionId: isHost ? sessionIdRef.current : null,
      pageOwnerIsHost: isHost,
      stateAtMs: now,
      sessionId: sessionIdRef.current,
      sender: username,
      avatar: getAvatar(username),
      timestamp: now
    }

    publishState(snapshot)

    // legacy sync for older clients: keep fraction-based played
    publishMessage({
      type: 'SYNC_STATE',
      playing: snapshot.playing,
      played: snapshot.progress
    })
  }, [isHost, isOverlay, nextLocalStateVersion, publishMessage, publishState, roomId, username])

  const claimCollaborativeLock = useCallback((reason = 'control') => {
    const now = Date.now()
    controlOwnerSessionRef.current = sessionIdRef.current
    controlOwnerUntilRef.current = now + CONTROL_OWNER_MS
    lastLockUpdateMsRef.current = now
    publishStateSnapshot(`lock_${reason}`)
  }, [publishStateSnapshot])

  const handleMqttMessage = useCallback((topic, data) => {
    if (!data || typeof data !== 'object') return
    const base = roomId ? roomBaseTopic(roomId) : ''
    const isLegacyTopic = base && topic === base
    const isStateTopic = roomId && topic === roomStateTopic(roomId)
    const isPresenceTopic = roomId && topic.startsWith(roomPresencePrefix(roomId))

    const isSelfMessage = data.sessionId
      ? data.sessionId === sessionIdRef.current
      : data.sender === username

    if (data.eventId && rememberEventId(data.eventId)) return

    if (isPresenceTopic && data.type === 'PRESENCE' && data.sessionId) {
      if (data.status === 'offline') {
        setMembers(prev => {
          if (!prev.has(data.sessionId)) return prev
          const next = new Map(prev)
          next.delete(data.sessionId)
          return next
        })
      } else {
        setMembers(prev => {
          const next = new Map(prev)
          next.set(data.sessionId, {
            sessionId: data.sessionId,
            username: data.sender,
            isHost: !!data.isHost,
            avatar: data.avatar || getAvatar(data.sender || '')
          })
          return next
        })
      }
      return
    }

    // legacy presence/join fallback
    if (isLegacyTopic && ['GUEST_JOIN', 'PRESENCE'].includes(data.type) && data.sender && (data.sessionId || data.sender)) {
      const memberKey = data.sessionId || data.sender
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

    const markRemoteHandling = () => {
      isRemoteRef.current = true
      setTimeout(() => { isRemoteRef.current = false }, 1500)
    }

    const maybeUpdateLockFromMessage = () => {
      const lockOwner = data.ownerSessionId
      const lockUntilMs = data.ownerUntilMs
      const lockAtMs = data.lockAtMs || data.timestamp
      if (!lockOwner || typeof lockUntilMs !== 'number') return
      if (typeof lockAtMs !== 'number') return
      if (lockAtMs <= lastLockUpdateMsRef.current) return
      lastLockUpdateMsRef.current = lockAtMs
      controlOwnerSessionRef.current = lockOwner
      controlOwnerUntilRef.current = lockUntilMs
    }

    const shouldApplyControlFromSender = (senderSessionId) => {
      const now = Date.now()
      const ownerSessionId = controlOwnerSessionRef.current
      const ownerUntilMs = controlOwnerUntilRef.current
      return !!senderSessionId && senderSessionId === ownerSessionId && now < ownerUntilMs
    }

    // 处理同步指令 -> 控制本地网页播放器
    if (isOverlay) {
      if (Date.now() < localControlUntilRef.current) {
        if (
          ['PLAY', 'PAUSE', 'SEEK', 'SYNC_STATE', 'PAGE_STATE', 'BUFFERING_START', 'BUFFERING_END'].includes(data.type) ||
          data.type === 'STATE'
        ) {
          return
        }
      }

      if (isStateTopic && data.type === 'STATE') {
        // basic sanity: only accept owner-published snapshots
        if (data.ownerSessionId && data.sessionId && data.ownerSessionId !== data.sessionId) return
        if (!data.ownerSessionId || typeof data.v !== 'number' || typeof data.stateAtMs !== 'number') return

        const last = lastAppliedStateRef.current
        const ownerChanged = last.ownerSessionId && data.ownerSessionId !== last.ownerSessionId
        if (!ownerChanged && data.v <= last.v) return
        lastAppliedStateRef.current = { ownerSessionId: data.ownerSessionId, v: data.v }

        controlOwnerSessionRef.current = data.ownerSessionId
        controlOwnerUntilRef.current = typeof data.ownerUntilMs === 'number' ? data.ownerUntilMs : (Date.now() + CONTROL_OWNER_MS)
        lastLockUpdateMsRef.current = typeof data.stateAtMs === 'number' ? data.stateAtMs : Date.now()

        const now = Date.now()
        const basePos = typeof data.positionSec === 'number' ? data.positionSec : 0
        const expected = data.playing ? (basePos + Math.max(0, (now - data.stateAtMs)) / 1000) : basePos

        markRemoteHandling()
        setPlaying(!!data.playing)
        sendCommandToParent('W2G_COMMAND_SYNC', { played: expected, playing: !!data.playing, isTime: true })

        if (data.pageState && typeof data.pageState === 'object') {
          if (data.pageOwnerIsHost) setHostPageState(data.pageState)
          sendCommandToParent('W2G_COMMAND_PAGE_STATE', data.pageState)
        }
        return
      }

      if (['PLAY', 'PAUSE', 'SEEK', 'PAGE_STATE', 'BUFFERING_START', 'BUFFERING_END'].includes(data.type) && data.sessionId) {
        controlOwnerSessionRef.current = data.sessionId
        controlOwnerUntilRef.current = Date.now() + CONTROL_OWNER_MS
      }

      switch (data.type) {
        case 'PLAY': {
          maybeUpdateLockFromMessage()
          if (!shouldApplyControlFromSender(data.sessionId)) return
          markRemoteHandling()
          setPlaying(true)
          if (typeof data.played !== 'undefined') {
            sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: true, isTime: true })
          } else {
            sendCommandToParent('W2G_COMMAND_PLAY')
          }
          break
        }
        case 'PAUSE': {
          maybeUpdateLockFromMessage()
          if (!shouldApplyControlFromSender(data.sessionId)) return
          markRemoteHandling()
          setPlaying(false)
          if (typeof data.played !== 'undefined') {
            sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: false, isTime: true })
          } else {
            sendCommandToParent('W2G_COMMAND_PAUSE')
          }
          break
        }
        case 'SEEK':
          maybeUpdateLockFromMessage()
          if (!shouldApplyControlFromSender(data.sessionId)) return
          markRemoteHandling()
          sendCommandToParent('W2G_COMMAND_SEEK', data.to)
          break
        case 'SYNC_STATE': {
          markRemoteHandling()
          if (typeof data.playing !== 'undefined') {
            setPlaying(!!data.playing)
          }
          if (typeof data.played !== 'undefined') {
            // legacy messages may carry either percentage (0..1) or seconds
            const isProbablyFraction = typeof data.played === 'number' && data.played >= 0 && data.played <= 1 && !data.isTime
            sendCommandToParent('W2G_COMMAND_SYNC', { played: data.played, playing: !!data.playing, isTime: !isProbablyFraction })
          }
          break
        }
        case 'PAGE_STATE':
          if (data.state) {
            maybeUpdateLockFromMessage()
            if (!shouldApplyControlFromSender(data.sessionId)) return
            markRemoteHandling()
            latestPageStateRef.current = data.state
            if (data.isHost) setHostPageState(data.state)
            sendCommandToParent('W2G_COMMAND_PAGE_STATE', data.state)
          }
          break
        case 'BUFFERING_START':
          maybeUpdateLockFromMessage()
          if (!shouldApplyControlFromSender(data.sessionId)) return
          markRemoteHandling()
          setPlaying(false)
          sendCommandToParent('W2G_COMMAND_PAUSE')
          break
        case 'BUFFERING_END':
          maybeUpdateLockFromMessage()
          if (!shouldApplyControlFromSender(data.sessionId)) return
          markRemoteHandling()
          if (typeof data.playing !== 'undefined' || typeof data.played !== 'undefined') {
            const nextPlaying = typeof data.playing !== 'undefined' ? !!data.playing : true
            const nextTime = typeof data.played === 'number' ? data.played : playedRef.current
            setPlaying(nextPlaying)
            sendCommandToParent('W2G_COMMAND_SYNC', { played: nextTime, playing: nextPlaying, isTime: true })
          }
          break
      }
    }

    // 房主同步状态给新人（legacy join）
    if (data.type === 'GUEST_JOIN' && !isSelfMessage && isOverlay) {
      publishStateSnapshot('guest_join')
      if (latestPageStateRef.current) {
        publishEvent({ type: 'PAGE_STATE', state: latestPageStateRef.current })
      }
    }
  }, [isHost, isOverlay, publishEvent, publishMessage, publishStateSnapshot, rememberEventId, roomId, sendCommandToParent, username])

  // 初始化检查
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('overlay') === 'true') {
      setIsOverlay(true)
      document.body.style.backgroundColor = 'transparent'
      document.documentElement.style.backgroundColor = 'transparent'
    }

    const tabIdParam = params.get('tabId')
    if (tabIdParam) {
      const parsed = Number(tabIdParam)
      if (Number.isFinite(parsed) && parsed > 0) setTargetTabId(parsed)
    }
  }, [])

  useEffect(() => {
    refreshControllableTabs()
  }, [refreshControllableTabs])

  // 监听来自父页面的视频事件 (Overlay Mode Only)
  useEffect(() => {
    const handlePlayerEvent = (type, payload) => {
      if (!type) return
      if (isRemoteRef.current) return

      switch (type) {
        case 'W2G_EVENT_PLAY':
          markLocalAuthority()
          claimCollaborativeLock('play')
          setPlaying(true)
          if (page === 'room') {
            publishEvent({ type: 'PLAY', played: payload.currentTime })
            publishStateSnapshot('play')
          }
          break
        case 'W2G_EVENT_PAUSE':
          markLocalAuthority()
          claimCollaborativeLock('pause')
          setPlaying(false)
          if (page === 'room') {
            publishEvent({ type: 'PAUSE', played: payload.currentTime })
            publishStateSnapshot('pause')
          }
          break
        case 'W2G_EVENT_SEEKED':
          markLocalAuthority()
          claimCollaborativeLock('seek')
          if (page === 'room') {
            publishEvent({ type: 'SEEK', to: payload.currentTime })
            setPlayed(payload.currentTime)
            publishStateSnapshot('seek')
          }
          break
        case 'W2G_EVENT_PROGRESS':
          if (typeof payload?.currentTime === 'number') setPlayed(payload.currentTime)
          if (typeof payload?.played === 'number') setProgress(payload.played)
          break
        case 'W2G_EVENT_PAGE_STATE':
          markLocalAuthority()
          claimCollaborativeLock('page_state')
          latestPageStateRef.current = payload
          if (isHost) setHostPageState(payload)
          if (page === 'room') {
            publishEvent({ type: 'PAGE_STATE', state: payload })
            publishStateSnapshot('page_state')
          }
          break
        case 'W2G_EVENT_BUFFERING_START':
          markLocalAuthority()
          claimCollaborativeLock('buffering_start')
          if (page === 'room') publishEvent({ type: 'BUFFERING_START', played: payload?.currentTime })
          break
        case 'W2G_EVENT_BUFFERING_END':
          markLocalAuthority()
          claimCollaborativeLock('buffering_end')
          if (page === 'room') {
            publishEvent({
              type: 'BUFFERING_END',
              played: payload?.currentTime,
              playing: payload?.playing
            })
            if (typeof payload?.currentTime === 'number') setPlayed(payload.currentTime)
            if (typeof payload?.playing !== 'undefined') setPlaying(!!payload.playing)
            publishStateSnapshot('buffering_end')
          }
          break
        case 'W2G_COPY_RESULT':
          setCopyTip(payload?.ok ? '已复制' : '复制失败')
          setTimeout(() => setCopyTip(''), 1200)
          break
      }
    }

    if (isOverlay) {
      const handleParentMessage = (event) => {
        if (event.source !== window.parent) return
        if (!event.data || typeof event.data !== 'object') return
        const { type, payload } = event.data
        handlePlayerEvent(type, payload)
      }
      window.addEventListener('message', handleParentMessage)
      return () => window.removeEventListener('message', handleParentMessage)
    }

    const handleRuntimeMessage = (message, sender) => {
      if (!message || typeof message !== 'object') return
      if (message.action !== 'W2G_PANEL_EVENT') return
      if (typeof targetTabId === 'number' && targetTabId > 0) {
        const senderTabId = sender?.tab?.id
        if (senderTabId !== targetTabId) return
      }
      handlePlayerEvent(message.type, message.payload)
    }

    try {
      globalThis.chrome?.runtime?.onMessage?.addListener(handleRuntimeMessage)
    } catch (err) {
      void err
    }

    return () => {
      try {
        globalThis.chrome?.runtime?.onMessage?.removeListener(handleRuntimeMessage)
      } catch (err) {
        void err
      }
    }
  }, [claimCollaborativeLock, isHost, isOverlay, markLocalAuthority, page, publishEvent, publishStateSnapshot, targetTabId])

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
        const presenceTopic = roomId ? `${roomPresencePrefix(roomId)}${sessionIdRef.current}` : ''
        const willPayload = {
          type: 'PRESENCE',
          status: 'offline',
          sessionId: sessionIdRef.current,
          sender: username,
          avatar: getAvatar(username),
          isHost,
          timestamp: Date.now()
        }
        const connectionOptions = {
          clientId: `w2g_${Math.random().toString(16).slice(2, 8)}`,
          keepalive: 60,
          protocolId: 'MQTT',
          protocolVersion: 4,
          clean: true,
          reconnectPeriod: 3000,
          connectTimeout: 10 * 1000,
          rejectUnauthorized: MQTT_CONFIG.rejectUnauthorized,
          ...(presenceTopic ? { will: { topic: presenceTopic, payload: JSON.stringify(willPayload), qos: 1, retain: true } } : {})
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
        const topics = [
          roomBaseTopic(roomId),
          roomEventTopic(roomId),
          roomStateTopic(roomId),
          `${roomPresencePrefix(roomId)}#`
        ]
        client.subscribe(topics, (err) => {
          if (!err) {
            publishPresence('online')
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
            const topics = [
              roomBaseTopic(roomId),
              roomEventTopic(roomId),
              roomStateTopic(roomId),
              `${roomPresencePrefix(roomId)}#`
            ]
            client.subscribe(topics, (err) => {
              if (!err) {
                publishPresence('online')
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
              handleMqttMessage(topic, JSON.parse(message.toString()))
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
          handleMqttMessage(topic, JSON.parse(message.toString()))
        } catch (err) {
          console.error('[W2G] MQTT message parse failed:', err)
        }
      })

      return () => {
        console.log('[W2G] Disconnecting MQTT')
        try {
          publishPresence('offline')
        } catch {
          // ignore
        }
        client.end()
        clientRef.current = null
        setConnectionStatus('disconnected')
      }
    }
  }, [handleMqttMessage, isHost, page, publishMessage, publishPresence, roomId, username])

  useEffect(() => {
    if (!(page === 'room' && isOverlay && connectionStatus === 'connected')) return

    const timer = setInterval(() => {
      if (isRemoteRef.current) return
      publishStateSnapshot('periodic')
    }, SYNC_BROADCAST_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [connectionStatus, isOverlay, page, publishStateSnapshot])

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

          {!isOverlay && controllableTabs.length > 0 && (
            <div style={{ position: 'absolute', top: '15px', left: '15px', right: '15px', zIndex: 30 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>控制标签页</span>
                <select
                  className="tab-select"
                  value={typeof targetTabId === 'number' ? targetTabId : ''}
                  onMouseDown={() => refreshControllableTabs()}
                  onChange={(e) => {
                    const nextId = Number(e.target.value)
                    if (!Number.isFinite(nextId)) return
                    setTargetTabId(nextId)
                    const sp = new URLSearchParams(window.location.search)
                    sp.set('tabId', String(nextId))
                    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`)
                  }}
                  style={{ flex: '1 1 auto', minWidth: 0 }}
                >
                  {controllableTabs.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.title ? t.title : t.url}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

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
            {!isOverlay && controllableTabs.length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap' }}>控制标签页</span>
                  <select
                    className="tab-select"
                    value={typeof targetTabId === 'number' ? targetTabId : ''}
                    onMouseDown={() => refreshControllableTabs()}
                    onChange={(e) => {
                      const nextId = Number(e.target.value)
                      if (!Number.isFinite(nextId)) return
                      setTargetTabId(nextId)
                      const sp = new URLSearchParams(window.location.search)
                      sp.set('tabId', String(nextId))
                      window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`)
                    }}
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                  >
                    {controllableTabs.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.title ? t.title : t.url}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

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

            {hostPageState?.url && (
              <div style={{ marginTop: '8px', fontSize: '0.8rem', textAlign: 'left' }}>
                <div style={{ color: '#888', marginBottom: '2px' }}>房主当前网页</div>
                <div
                  style={{ color: '#cba168', cursor: 'pointer', wordBreak: 'break-all', textDecoration: 'underline' }}
                  title="点击打开房主网页"
                  onClick={() => {
                    try {
                      window.open(hostPageState.url, '_blank', 'noopener,noreferrer')
                    } catch (err) {
                      void err
                    }
                  }}
                >
                  {hostPageState.title ? hostPageState.title : hostPageState.url}
                </div>
              </div>
            )}
            
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
              <div key={m.sessionId || m.username} className="member-card" style={{ padding: '8px', marginBottom: '5px' }}>
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
