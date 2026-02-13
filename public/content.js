// W2G Content Script (ISOLATED World)
// 负责注入 UI 和与扩展后台通信

const UI_ID = 'w2g-overlay-container';
const IFRAME_ID = 'w2g-app-frame';
let isUIVisible = false;
let isMinimized = false; // 最小化状态
let dragStartTime = 0;
let dragStartX = 0;
let dragStartY = 0;
let isDragging = false; // 明确区分是否发生了拖动

// 初始化注入逻辑
function init() {
    console.log('[W2G] Content Script Initialized');
    
    // 监听来自 Popup 的消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'TOGGLE_UI') {
            toggleUI();
            sendResponse({ status: 'ok', visible: isUIVisible });
        }
    });

    // 注入全局样式
    injectStyles();
}

function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes rune-pulse {
            0% { box-shadow: 0 0 10px rgba(203, 161, 104, 0.3); }
            50% { box-shadow: 0 0 25px rgba(203, 161, 104, 0.8); }
            100% { box-shadow: 0 0 10px rgba(203, 161, 104, 0.3); }
        }
        @keyframes rune-flow {
            0% { background-position: 0% 50%; }
            100% { background-position: 100% 50%; }
        }
        
        /* 最小化状态 */
        #w2g-overlay-container.minimized {
            width: 60px !important;
            height: 60px !important;
            border-radius: 50% !important;
            overflow: visible !important;
            background: rgba(20, 20, 20, 0.9) !important;
            cursor: pointer;
            display: flex !important;
            align-items: center;
            justify-content: center;
            animation: rune-pulse 3s infinite ease-in-out;
            border: 2px solid #cba168;
            box-shadow: 0 0 15px rgba(203, 161, 104, 0.5);
        }
        #w2g-overlay-container.minimized iframe,
        #w2g-overlay-container.minimized .rune-border {
            display: none !important;
        }
        #w2g-overlay-container.minimized::after {
            content: 'ᛟ';
            color: #cba168;
            font-size: 30px;
            font-weight: bold;
            display: block;
        }

        /* 符文外框装饰 */
        .rune-border {
            position: absolute;
            background: #cba168;
            opacity: 0.6;
            pointer-events: none;
            z-index: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            font-size: 10px;
            color: rgba(20, 20, 20, 0.8);
            font-weight: bold;
            letter-spacing: 2px;
            white-space: nowrap;
        }
        
        .rune-border.top, .rune-border.bottom {
            height: 2px;
            left: 10px;
            right: 10px;
        }
        .rune-border.top { top: 5px; }
        .rune-border.bottom { bottom: 5px; }

        .rune-border.left, .rune-border.right {
            width: 2px;
            top: 10px;
            bottom: 10px;
        }
        .rune-border.left { left: 5px; }
        .rune-border.right { right: 5px; }

        /* 外框角点装饰 */
        .rune-corner {
            position: absolute;
            width: 8px;
            height: 8px;
            border: 2px solid #cba168;
            z-index: 2;
            pointer-events: none;
        }
        .rune-corner.tl { top: 0; left: 0; border-right: none; border-bottom: none; }
        .rune-corner.tr { top: 0; right: 0; border-left: none; border-bottom: none; }
        .rune-corner.bl { bottom: 0; left: 0; border-right: none; border-top: none; }
        .rune-corner.br { bottom: 0; right: 0; border-left: none; border-top: none; }
    `;
    document.head.appendChild(style);
}

// 切换 UI 显示/隐藏
function toggleUI() {
    let container = document.getElementById(UI_ID);
    
    if (!container) {
        createUI();
        isUIVisible = true;
    } else {
        isUIVisible = !isUIVisible;
        container.style.display = isUIVisible ? 'block' : 'none';
        // 每次重新打开时，如果处于最小化状态，则恢复
        if (isUIVisible && isMinimized) {
            toggleMinimize();
        }
    }
}

// 创建 Iframe 容器
function createUI() {
    const container = document.createElement('div');
    container.id = UI_ID;
    Object.assign(container.style, {
        position: 'fixed',
        top: '20px',
        right: '80px',
        width: '400px', // 侧边栏宽度
        height: '600px',
        backgroundColor: 'transparent', // 容器本身透明
        zIndex: '2147483646',
        borderRadius: '0', // 去掉容器圆角，改由内部装饰负责
        display: 'block',
        transition: 'width 0.3s, height 0.3s',
        padding: '10px', // 给外框留出空间
        boxSizing: 'content-box' // 关键：width/height (400x600) 是内容区域(iframe)的大小，外框自动撑大
    });

    // 拖动逻辑
    makeDraggable(container);

    // 最小化点击恢复逻辑 (仅在最小化状态下生效)
    // 注意：非最小化状态下的点击由 iframe 处理或通过 App 内部按钮触发
    container.addEventListener('mousedown', (e) => {
        if (!isMinimized) return; // 只有最小化时才需要监听点击恢复
        dragStartTime = Date.now();
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        isDragging = false;
    });

    container.addEventListener('mouseup', (e) => {
        if (!isMinimized) return;
        
        const dist = Math.sqrt(Math.pow(e.clientX - dragStartX, 2) + Math.pow(e.clientY - dragStartY, 2));
        if (dist > 5) {
            isDragging = true;
        }

        if (!isDragging) {
            toggleMinimize();
        }
    });

    // 添加外部符文框
    addRuneBorder(container);

    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    const appUrl = chrome.runtime.getURL('index.html') + '?overlay=true'; 
    iframe.src = appUrl;
    // iframe 内部禁止滚动
    iframe.setAttribute('scrolling', 'no');
    
    Object.assign(iframe.style, {
        width: '100%',
        height: '100%',
        border: 'none',
        background: 'transparent',
        borderRadius: '12px',
        position: 'relative',
        zIndex: '10'
    });

    container.appendChild(iframe);
    
    document.body.appendChild(container);

    // 建立与 Iframe 的通信
    window.addEventListener('message', handleIframeMessage);
    
    // 监听当前页面的视频事件并转发给 Iframe
    setupVideoListener();
}

function addRuneBorder(container) {
    // 四边线条
    ['top', 'bottom', 'left', 'right'].forEach(pos => {
        const div = document.createElement('div');
        div.className = `rune-border ${pos}`;
        container.appendChild(div);
    });

    // 四角装饰
    ['tl', 'tr', 'bl', 'br'].forEach(pos => {
        const div = document.createElement('div');
        div.className = `rune-corner ${pos}`;
        container.appendChild(div);
    });
}

function toggleMinimize() {
    const container = document.getElementById(UI_ID);
    if (!container) return;

    isMinimized = !isMinimized;
    if (isMinimized) {
        container.classList.add('minimized');
    } else {
        container.classList.remove('minimized');
    }
}

// 拖动功能实现
function makeDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    // 方案：在 container 顶部添加一个透明的 handle
    const handle = document.createElement('div');
    Object.assign(handle.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: 'calc(100% - 40px)', // 避开右上角最小化按钮区域 (40px)
        height: '40px', // 对应 App 内部 Header 的高度
        zIndex: '20', // 在 iframe 之上
        cursor: 'move',
        // background: 'rgba(255, 0, 0, 0.2)' // debug 用，确认区域位置
    });
    element.appendChild(handle);

    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        // 如果点击的是右上角区域（即便 handle 已经避开，为了双重保险），不处理
        // 由于 handle 宽度已经限制，这里只需要处理左键
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
        
        // 拖动时给 iframe 添加 pointer-events: none 以防卡顿
        const iframe = document.getElementById(IFRAME_ID);
        if(iframe) iframe.style.pointerEvents = 'none';
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
        element.style.right = 'auto';
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        const iframe = document.getElementById(IFRAME_ID);
        if(iframe) iframe.style.pointerEvents = 'auto';
    }
}


// 处理来自 Iframe (React App) 的消息
function handleIframeMessage(event) {
    // 安全检查
    if (!event.data || !event.data.type) return;

    const { type, payload } = event.data;
    const video = findMainVideo();

    switch (type) {
        case 'W2G_COMMAND_PLAY':
            if(video) video.play();
            break;
        case 'W2G_COMMAND_PAUSE':
            if(video) video.pause();
            break;
        case 'W2G_COMMAND_SEEK':
            if (video && typeof payload === 'number') {
                // 兼容两种格式：0~1 的进度百分比，或绝对秒数
                const nextTime = payload <= 1 ? payload * video.duration : payload;
                video.currentTime = nextTime;
            }
            break;
        case 'W2G_COMMAND_SYNC':
            if (video && payload) {
                const targetTime = payload.isTime
                    ? payload.played
                    : payload.played * video.duration;
                if (typeof targetTime === 'number' && Math.abs(video.currentTime - targetTime) > 2) {
                    video.currentTime = targetTime;
                }
                if (payload.playing && video.paused) video.play();
                if (!payload.playing && !video.paused) video.pause();
            }
            break;
        case 'W2G_COMMAND_MINIMIZE':
            toggleMinimize();
            break;
        case 'W2G_COMMAND_CLOSE':
            toggleUI(); // 关闭逻辑与 toggle 相同
            break;
    }
}

// 监听页面视频事件
function setupVideoListener() {
    const video = findMainVideo();
    if (!video) {
        setTimeout(setupVideoListener, 2000);
        return;
    }

    console.log('[W2G] Video found, attaching listeners');
    
    const notifyIframe = (type, data) => {
        const iframe = document.getElementById(IFRAME_ID);
        // 即使最小化也持续发送事件，保证 MQTT 同步不中断
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ type, payload: data }, '*');
        }
    };

    video.addEventListener('play', () => notifyIframe('W2G_EVENT_PLAY', { currentTime: video.currentTime }));
    video.addEventListener('pause', () => notifyIframe('W2G_EVENT_PAUSE', { currentTime: video.currentTime }));
    video.addEventListener('timeupdate', () => {
        const progress = video.duration ? (video.currentTime / video.duration) : 0;
        notifyIframe('W2G_EVENT_PROGRESS', { played: progress, currentTime: video.currentTime });
    });
    video.addEventListener('seeked', () => notifyIframe('W2G_EVENT_SEEKED', { currentTime: video.currentTime }));
}

// 辅助：查找主要视频元素
function findMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];
    return videos.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return (rectB.width * rectB.height) - (rectA.width * rectA.height);
    })[0];
}

// 启动
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
