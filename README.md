# Lyon Vysor Self

A premium desktop application for Android screen mirroring and control.

## Prerequisites
- **Node.js** (v18 or higher)
- **ADB** (Android Debug Bridge) installed and in your PATH.
- An Android device with **USB Debugging** enabled.

## Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run in Development Mode**:
   ```bash
   npm run dev
   ```

## Project Structure
- `main.js`: Electron main process.
- `vite.config.js`: Vite & Electron integration config.
- `src/App.jsx`: Main UI dashboard.


//*************************************//
運作原理簡述：
前端請求 (React - App.jsx)：當你點擊 "Refresh" 時，前端透過 ipcRenderer.invoke('get-devices') 向後端發送一個「信號」。
後端處理 (Node.js - main.js)：
後端收到信號後，透過 exec('adb devices -l') 啟動一個子進程來執行系統命令。
這就像是你手動在終端機輸入 adb devices -l 一樣。
Node.js 捕捉到命令輸出的「字串」，並用程式碼將其解析為 JSON 格式（包含序列號、型號等）。
返回數據：後端將解析好的設備列表發送回前端。
UI 更新：React 接收到數據後更新 useState 狀態，觸發介面重新渲染，設備就顯示在螢幕上了。
目前程式碼狀態

main.js
：已加入系統指令執行與數據解析的詳盡註解。

src/App.jsx
：已加入關於 IPC 通訊、React 狀態管理與介面渲染的註解。# lyon_vysor_electron
