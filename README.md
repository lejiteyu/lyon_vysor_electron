# Lyon Vysor Self (Android Mirroring & Control)

這是一個基於 Electron、Vite 與 Scrcpy 協議實作的 Android 螢幕鏡像與遠端控制工具。它能透過 USB 提供低延遲的影像串流，並支援精準的滑鼠點擊控制。

## 🚀 核心功能
- **低延遲影像**：使用 `scrcpy-server` v2.4 進行高效能 H.264 編碼串流。
- **雙路徑控制**：結合 Scrcpy 二進制協議與 ADB Fallback 指令，確保觸控操作 100% 成功。
- **智慧座標映射**：自動換算鏡像視窗座標至手機真實物理像素，支援橫屏與豎屏切換。
- **物標監控面板**：即時顯示滑鼠在手機上的實際座標與連線狀態。

---

## 📂 檔案運作原理說明

### 1. `main.js` (主進程 - 系統大腦)
這是整個程式的核心，負責所有與作業系統和 Android 設備的溝通：
- **ADB 流程管理**：負責偵測裝置、推送 `.jar` 伺服器檔、建立 `adb reverse` 端口轉發。
- **TCP 伺服器**：建立一個 Socket Server 監聽手機連入。第一個連入的是 **Video Socket** (串流數據)，第二個是 **Control Socket** (指令發送)。
- **指令注入 (Inject Touch)**：將前端傳來的視窗坐標，根據手機真實解析度進行縮放後，同時發送二進制封包給 Socket，並輔以 `adb shell input tap` 指令。
- **生命週期**：監控視窗關閉事件，並在關閉時自動清理手機端的伺服器進程。

### 2. `src/App.jsx` (前端進入點 & 路由)
- **裝置列表**：啟動時呼叫 `get-devices` 並渲染美觀的裝置清單。
- **Hash 路由**：使用 `# /mirror` 路由來區分「主畫面」與「鏡像視窗」，讓 Vite 在開發模式下能穩定載入不同視窗內容。

### 3. `src/mirror.jsx` (影像渲染器 & 交互層)
- **JMuxer 整合**：接收來自後端的原始 H.264 數據流，並即時解碼餵入 `<video>` 標籤。
- **起始碼搜尋 (Heuristic Sync)**：為了防止影像錯位，會自動掃描封包中的 `00 00 00 01` 起始碼進行對齊，解決黑屏問題。
- **座標監控**：計算滑鼠相對於影片內容的比例，換算出手機端對應的 X/Y，並回傳給主進程執行點擊。

### 4. `scrcpy-server-v2.4.jar` (Android 端服務)
- 這是由 Genymobile 開發的 Java 程式，執行在 Android 的 `app_process` 中。
- 它直接存取 Android 的 `SurfaceControl` 獲取影像，並利用 `MediaCodec` 進行硬體編碼發回給電腦。

---

## 🛠 技術架構圖 (Data Flow)

1. **影像傳輸路徑**：
   `Android (H.264)` ➔ `ADB Reverse` ➔ `TCP Socket (main.js)` ➔ `IPC (Electron)` ➔ `JMuxer (Renderer)` ➔ `Video Tag`

2. **控制指令路徑**：
   `Mouse Click` ➔ `Coordinate Mapping (mirror.jsx)` ➔ `IPC` ➔ `main.js` ➔ `Socket / ADB shell tap` ➔ `Android InputManager`

---

## 📦 安裝與開發

### 環境需求
- **Node.js**: v16.x 或更高版本
- **ADB**: 需安裝 Android Platform Tools 並加入系統環境變數

### 啟動開發環境
```bash
npm install
npm run dev
```

### Git 上傳注意事項
本專案已配置 `.gitignore`。請勿上傳 `node_modules`、`dist` 與 `dist-electron` 資料夾，以保持倉庫精簡。

---

## ⚠️ 常見問題 (Troubleshooting)
- **畫面黑屏**：請確保手機端開啟了「USB 偵錯」。
- **無法點擊**：請確保手機開啟了「USB 偵錯（安全設定）」，否則 Android 會攔截模擬觸控。
- **座標偏離**：程式會自動偵測 `wm size`，若解析度異常，請嘗試重新插拔手機。
