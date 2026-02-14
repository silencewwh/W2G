// 核心逻辑：抓取视频网站 + 同步房间所有人播放进度

// Configuration
const CONFIG = {
    videoTagNames: ['video', 'bwp-video'], // 支持的视频标签
    reportInterval: 1000, // 上报间隔 (ms)
    roomName: 'default-room', // 默认房间名，实际应从 URL 或存储获取
    tempUser: 'user-' + Math.random().toString(36).substr(2, 9), // 临时用户 ID
};

class VideoSynchronizer {
    constructor() {
        this.activatedVideo = null;
        this.videoState = {
            currentTime: 0,
            paused: true,
            playbackRate: 1,
            url: '',
            duration: 0,
            m3u8Url: '',
            videoTitle: document.title
        };
        
        this.observer = null;
        this.reportTimer = null;
        
        this.init();
    }

    init() {
        console.log('[W2G] Initializing Video Synchronizer...');
        this.hijackNetwork(); // 注入 fetch/XHR 劫持逻辑
        this.createVideoDomObserver(); // 监听视频 DOM 变化
        this.startReporting(); // 定时上报状态
    }

    // --- 1. 网络劫持 (Fetch/XHR) ---
    // 目的：获取 M3U8 流地址等隐藏信息，处理跨域
    hijackNetwork() {
        const self = this;

        // 劫持 Fetch
        const originalFetch = window.fetch;
        window.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : input.url;
            self.checkForM3U8(url);
            
            // 这里保留原有的代理逻辑接口，如果需要
            // return originalFetch.apply(this, arguments);
            return originalFetch(input, init);
        };

        // 劫持 XHR
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            self.checkForM3U8(url);
            return originalOpen.apply(this, arguments);
        };
    }

    checkForM3U8(url) {
        if (url && (url.includes('.m3u8') || url.includes('.flv'))) {
            // console.log('[W2G] Detected Stream URL:', url);
            this.videoState.m3u8Url = url;
        }
    }

    // --- 2. 视频元素探测 ---
    createVideoDomObserver() {
        // 初始查找
        this.findAndAttachVideo();

        // 监听 DOM 变化，自动附加新出现的视频
        this.observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    shouldScan = true;
                    break;
                }
            }
            if (shouldScan) {
                this.findAndAttachVideo();
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    findAndAttachVideo() {
        // 如果当前已经有激活的视频且还在文档中，跳过
        if (this.activatedVideo && document.contains(this.activatedVideo)) {
            return;
        }

        // 遍历所有支持的标签
        for (const tagName of CONFIG.videoTagNames) {
            const videos = document.getElementsByTagName(tagName);
            if (videos.length > 0) {
                // 简单策略：取第一个可见的视频，或者正在播放的视频
                // 这里取第一个找到的
                const video = videos[0];
                this.attachVideoEvents(video);
                break; 
            }
        }
    }

    attachVideoEvents(videoElement) {
        if (this.activatedVideo === videoElement) return;

        console.log('[W2G] Attached to video element:', videoElement);
        this.activatedVideo = videoElement;

        // 更新基础信息
        this.updateVideoInfo();

        // 绑定事件
        const events = ['timeupdate', 'play', 'pause', 'ratechange', 'seeking', 'seeked'];
        events.forEach(eventType => {
            videoElement.addEventListener(eventType, () => this.handleVideoEvent(eventType));
        });
    }

    updateVideoInfo() {
        if (!this.activatedVideo) return;
        
        this.videoState.url = window.location.href;
        this.videoState.duration = this.activatedVideo.duration || 0;
        this.videoState.videoTitle = document.title;
        
        // 尝试获取 m3u8Url (如果之前的劫持没抓到，这里可能需要特定逻辑，暂时留空)
    }

    handleVideoEvent(eventType) {
        if (!this.activatedVideo) return;

        // 同步状态到实例属性
        this.videoState.currentTime = this.activatedVideo.currentTime;
        this.videoState.paused = this.activatedVideo.paused;
        this.videoState.playbackRate = this.activatedVideo.playbackRate;

        // console.log(`[W2G] Video Event: ${eventType}`, this.videoState);
        
        // 可选：立即上报重要事件 (如 play/pause/seeked)
        if (['play', 'pause', 'seeked', 'ratechange'].includes(eventType)) {
            this.reportStatus();
        }
    }

    // --- 3. 定时上报状态 ---
    startReporting() {
        if (this.reportTimer) clearInterval(this.reportTimer);
        this.reportTimer = setInterval(() => {
            this.reportStatus();
        }, CONFIG.reportInterval);
    }

    reportStatus() {
        if (!this.activatedVideo) return;

        const payload = {
            roomName: CONFIG.roomName,
            tempUser: CONFIG.tempUser,
            videoState: {
                ...this.videoState,
                timestamp: Date.now()
            }
        };

        // 模拟上报接口
        // 实际场景中，这里会通过 MQTT 或 WebSocket 发送
        this.sendToBackend(payload);
    }

    sendToBackend() {
        // Mock backend communication
        // console.log('[W2G] Reporting status:', payload);
        
        // 这里预留接口，实际会调用 MQTT 发送
        // mqttClient.publish(`room/${payload.roomName}/status`, JSON.stringify(payload));
    }

    // --- 接收后端广播并同步 (预留接口) ---
    onBackendMessage(message) {
        // 收到后端广播的"权威状态"，进行同步
        // 简单逻辑：如果误差超过阈值，则强制同步
        if (!this.activatedVideo) return;

        const { currentTime, paused, playbackRate } = message;
        
        // 同步播放状态
        if (this.activatedVideo.paused !== paused) {
            if (paused) this.activatedVideo.pause();
            else this.activatedVideo.play();
        }

        // 同步进度 (防止死循环，只有误差大时才同步)
        if (Math.abs(this.activatedVideo.currentTime - currentTime) > 2) {
            console.log('[W2G] Syncing time...', currentTime);
            this.activatedVideo.currentTime = currentTime;
        }

        // 同步速率
        if (this.activatedVideo.playbackRate !== playbackRate) {
            this.activatedVideo.playbackRate = playbackRate;
        }
    }
}

// 启动实例
const synchronizer = new VideoSynchronizer();

// 暴露给全局以便调试
window._w2g_synchronizer = synchronizer;
