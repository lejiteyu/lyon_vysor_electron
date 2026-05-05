import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import fs from 'fs';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let mirrorWindow;
let isStreaming = false;
let tcpServer = null;

let videoSocket = null;
let controlSocket = null;
let connectionCount = 0;
let currentSerial = '';

let deviceW = 0;
let deviceH = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 850, titleBarStyle: 'hiddenInset', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

app.whenReady().then(createWindow);

ipcMain.handle('get-devices', async () => {
  try {
    const { stdout } = await execAsync('adb devices -l');
    const lines = stdout.trim().split('\n').slice(1);
    return lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      const modelMatch = line.match(/model:(\S+)/);
      return {
        serial: parts[0],
        status: parts[1],
        model: modelMatch ? modelMatch[1].replace(/_/g, ' ') : 'Unknown Device',
      };
    }).filter(Boolean);
  } catch (e) { return []; }
});

ipcMain.on('start-mirroring', async (event, { device, maxSize = 800 }) => {
  if (isStreaming) return;
  currentSerial = device.serial;
  const { serial } = device;

  try {
    // ... (維持原本的 wm size 獲取邏輯)
    try {
      const { stdout: sizeOut } = await execAsync(`adb -s ${serial} shell wm size`);
      const sizeMatch = sizeOut.match(/(\d+)x(\d+)/g);
      if (sizeMatch) {
        const [w, h] = sizeMatch[sizeMatch.length - 1].split('x').map(Number);
        deviceW = w;
        deviceH = h;
      }
    } catch(e){}

    if (!mirrorWindow) {
      mirrorWindow = new BrowserWindow({
        width: 500, height: 850, backgroundColor: '#000',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      const baseUrl = process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname, 'dist/index.html')}`;
      mirrorWindow.loadURL(`${baseUrl}#/mirror`);
      
      mirrorWindow.on('closed', () => { 
        mirrorWindow = null; isStreaming = false;
        if (tcpServer) { tcpServer.close(); tcpServer = null; }
        videoSocket = null; controlSocket = null; connectionCount = 0;
        exec(`adb -s ${serial} shell pkill -f scrcpy-server`);
      });

      mirrorWindow.webContents.on('did-finish-load', () => {
        // 發送設備資訊給前端
        mirrorWindow.webContents.send('device-info', { deviceW, deviceH });

        // 根據手機比例自動調整視窗大小
        if (deviceW > 0 && deviceH > 0) {
          const ratio = deviceW / deviceH;
          const windowH = 850;
          const videoH = windowH - 70; // 減去底部導航欄高度
          const windowW = Math.round(videoH * ratio);
          
          // 限制視窗寬度，避免過寬或過窄
          const finalW = Math.max(350, Math.min(windowW, 1000));
          mirrorWindow.setSize(finalW, windowH);
          mirrorWindow.center();
          console.log(`Resized mirror window to ${finalW}x${windowH} (Ratio: ${ratio})`);
        }
      });
    }

    if (tcpServer) tcpServer.close();
    tcpServer = net.createServer((socket) => {
      socket.setNoDelay(true);
      connectionCount++;
      if (connectionCount === 1) {
        videoSocket = socket;
        isStreaming = true;
        if (mirrorWindow) mirrorWindow.webContents.send('stream-reset');
        videoSocket.on('data', (chunk) => {
          if (mirrorWindow) mirrorWindow.webContents.send('video-data', chunk);
        });
      } else if (connectionCount === 2) {
        controlSocket = socket;
        controlSocket.on('data', (data) => {
          try {
            if (data[0] === 0 && data.length > 5) {
              const textLength = data.readUInt32BE(1);
              const text = data.slice(5, 5 + textLength).toString('utf8');
              if (text) clipboard.writeText(text);
            }
          } catch (err) {}
        });
      }
    });

    tcpServer.listen(12345, '127.0.0.1');

    try { await execAsync(`adb -s ${serial} shell pkill -f scrcpy-server`); } catch(e){}
    try { await execAsync(`adb -s ${serial} reverse localabstract:scrcpy tcp:12345`); } catch(e){}

    let serverPath = path.join(__dirname, 'scrcpy-server-v2.4.jar');
    if (!fs.existsSync(serverPath)) serverPath = path.join(__dirname, '..', 'scrcpy-server-v2.4.jar');
    await execAsync(`adb -s ${serial} push "${serverPath}" /data/local/tmp/scrcpy-server.jar`);

    // 啟動伺服器並監聽輸出
    const scrcpyProcess = spawn('adb', [
      '-s', serial, 'shell', 
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', 
      '2.4', 'video=true', 'audio=false', 'control=true', `max_size=${maxSize}`, 
      'video_codec=h264', 'video_bit_rate=4000000', 'max_fps=60', 'tunnel_forward=false'
    ]);

    scrcpyProcess.stdout.on('data', (data) => console.log(`[Scrcpy Server]: ${data}`));
    scrcpyProcess.stderr.on('data', (data) => console.error(`[Scrcpy Error]: ${data}`));

  } catch (err) {
    console.error('Mirroring failed:', err);
  }
});

// 新增：重啟鏡像指令 (不關閉視窗)
ipcMain.on('restart-mirror', (event) => {
  if (currentSerial) {
    console.log('Restarting mirror for', currentSerial);
    isStreaming = false;
    connectionCount = 0;
    // 重新發送開始鏡像指令，參數沿用之前的 (這段簡化處理)
    ipcMain.emit('start-mirroring', event, { device: { serial: currentSerial }, maxSize: 1024 });
  }
});

// 追蹤觸控起始點，用於判斷是點擊還是滑動
let lastDownX = 0;
let lastDownY = 0;
let lastDownTime = 0;
let longPressTimer = null;

ipcMain.on('inject-touch', (event, { action, x, y, width, height }) => {
  if (!currentSerial || deviceW === 0) return;

  // 計算物理座標
  let finalX, finalY;
  const realMax = Math.max(deviceW, deviceH);
  const realMin = Math.min(deviceW, deviceH);
  if (width > height) {
    finalX = Math.round((x / width) * realMax);
    finalY = Math.round((y / height) * realMin);
  } else {
    finalX = Math.round((x / width) * realMin);
    finalY = Math.round((y / height) * realMax);
  }

  if (action === 0) { // ACTION_DOWN
    lastDownX = finalX;
    lastDownY = finalY;
    lastDownTime = Date.now();

    // 清除舊的計時器並啟動長按計時器
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      console.log(`ADB Fallback: Long Press detected at ${finalX}, ${finalY}`);
      exec(`adb -s ${currentSerial} shell input swipe ${finalX} ${finalY} ${finalX} ${finalY} 1000`);
      longPressTimer = null;
    }, 600); // 600ms 後判定為長按
  }

  if (action === 2) { // ACTION_MOVE
    const dx = finalX - lastDownX;
    const dy = finalY - lastDownY;
    // 如果移動距離超過 10 像素，取消長按判定
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  }

  // 1. Socket 路徑 (負責流暢移動預覽)
  if (controlSocket) {
    const msg = Buffer.alloc(28);
    let offset = 0;
    msg.writeUInt8(2, offset++); 
    msg.writeUInt8(action, offset++); 
    msg.writeBigInt64BE(0n, offset); offset += 8; 
    msg.writeInt32BE(x, offset); offset += 4; 
    msg.writeInt32BE(y, offset); offset += 4;
    msg.writeUInt16BE(width, offset); offset += 2; 
    msg.writeUInt16BE(height, offset); offset += 2;
    msg.writeUInt16BE(action === 1 ? 0 : 0xffff, offset); offset += 2; 
    msg.writeUInt32BE(0, offset); offset += 4; 
    controlSocket.write(msg);
  }

  // 2. 智慧型 ADB 保底 (ACTION_UP)
  if (action === 1) { // ACTION_UP
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    const dx = finalX - lastDownX;
    const dy = finalY - lastDownY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - lastDownTime;

    // 如果時間太短且距離很近，判定為點擊
    if (distance < 10 && duration < 600) {
      console.log(`ADB Fallback: Tap at ${finalX}, ${finalY}`);
      exec(`adb -s ${currentSerial} shell input tap ${finalX} ${finalY}`);
    } else if (distance >= 10) {
      // 判定為滑動
      console.log(`ADB Fallback: Swipe from ${lastDownX},${lastDownY} to ${finalX},${finalY}`);
      exec(`adb -s ${currentSerial} shell input swipe ${lastDownX} ${lastDownY} ${finalX} ${finalY} 200`);
    }
  }
});

// --- 新增：將電腦剪貼簿傳送到手機 ---
ipcMain.on('set-clipboard', (event, text) => {
  if (controlSocket && text) {
    const textBuf = Buffer.from(text, 'utf8');
    // Scrcpy Type 9 (SET_CLIPBOARD) 格式:
    // Type(1), Sequence(8), Paste(1), Length(4), Text(N)
    const msg = Buffer.alloc(1 + 8 + 1 + 4 + textBuf.length);
    let offset = 0;
    msg.writeUInt8(9, offset++); // Type 9
    msg.writeBigInt64BE(0n, offset); offset += 8; // Sequence
    msg.writeUInt8(1, offset++); // Paste: true (自動貼上)
    msg.writeUInt32BE(textBuf.length, offset); offset += 4;
    textBuf.copy(msg, offset);
    
    controlSocket.write(msg);
    console.log('Synced clipboard to device:', text);
  }
});

// --- 新增：發送系統按鍵 (Home, Back, Recents 等) ---
ipcMain.on('send-key', (event, keycode) => {
  if (controlSocket) {
    // Scrcpy Type 0 (INJECT_KEYCODE) 格式:
    // Type(1), Action(1), Keycode(4), Repeat(4), Meta(4) = 14 bytes
    const msg = Buffer.alloc(14);
    msg.writeUInt8(0, 0); // Type 0: Keycode
    
    // 按下 (Down)
    msg.writeUInt8(0, 1); // Action 0: Down
    msg.writeUInt32BE(keycode, 2);
    msg.writeUInt32BE(0, 6);
    msg.writeUInt32BE(0, 10);
    controlSocket.write(msg);
    
    // 放開 (Up)
    msg.writeUInt8(1, 1); // Action 1: Up
    controlSocket.write(msg);
    
    // (B) ADB 路徑 - 系統按鍵保底 (Home, Back, Recents 等)
    // 這些按鍵在某些新手機上會被 Socket 攔截，但 ADB 一定有效
    if (keycode === 3 || keycode === 4 || keycode === 187) {
      console.log(`ADB Injecting Keyevent: ${keycode}`);
      exec(`adb -s ${currentSerial} shell input keyevent ${keycode}`);
    }
    
    console.log('Sent Keycode:', keycode);
  }
});
