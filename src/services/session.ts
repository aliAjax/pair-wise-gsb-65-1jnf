/** 每个浏览器窗口/标签页的会话标识：同一应用开两个窗口时互不相同，用于冲突审计 */
export const SESSION_ID = `WIN-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
