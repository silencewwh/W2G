// Background script for W2G Extension
console.log('W2G Extension Background Service Worker Loaded');

chrome.action.onClicked.addListener(async (tab) => {
	const tabId = tab?.id
	const url = chrome.runtime.getURL(`index.html?standalone=true${tabId ? `&tabId=${tabId}` : ''}`)

	try {
		await chrome.windows.create({
			url,
			type: 'popup',
			width: 420,
			height: 720
		})
	} catch (err) {
		console.error('[W2G] Failed to open standalone window:', err)
	}
})
