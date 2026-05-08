// Service worker — currently no-op. Reserved for the future "Send via
// right-click" context menu and toolbar-icon badge updates. Keeping the
// file around so manifest.json's `background.service_worker` resolves
// without errors during install.
chrome.runtime.onInstalled.addListener(() => {
  // no-op
});
