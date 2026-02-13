document.getElementById('toggleBtn').addEventListener('click', async () => {
    // 获取当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
        // 发送消息给 Content Script
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_UI' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError.message);
                // 可能是因为页面没有加载 content script (例如 chrome:// 页面)
            } else {
                console.log('UI Toggled:', response);
                window.close(); // 自动关闭 Popup
            }
        });
    }
});
