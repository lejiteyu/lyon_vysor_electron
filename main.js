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
        mirrorWindow.webContents.send('device-info', { deviceW, deviceH });
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

    spawn('adb', [
      '-s', serial, 'shell', 
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', 
      '2.4', 'video=true', 'audio=false', 'control=true', `max_size=${maxSize}`, 
      'video_codec=h264', 'video_bit_rate=8000000', 'tunnel_forward=false'
    ]);

  } catch (err) {
    console.error('Mirroring failed:', err);
  }
});

ipcMain.on('inject-touch', (event, { action, x, y, width, height }) => {
  if (!currentSerial || deviceW === 0) return;

  // 1. 計算手機端真實的物理座標 (這是萬能鑰匙)
  let finalX, finalY;
  const realMax = Math.max(deviceW, deviceH);
  const realMin = Math.min(deviceW, deviceH);
  if (width > height) { // 橫屏
    finalX = Math.round((x / width) * realMax);
    finalY = Math.round((y / height) * realMin);
  } else { // 豎屏
    finalX = Math.round((x / width) * realMin);
    finalY = Math.round((y / height) * realMax);
  }

  // 2. 雙路徑注入
  // (A) Socket 路徑 - 為了長按與拖動 (如果手機支持)
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
    msg.writeUInt32BE(action === 1 ? 0 : 1, offset); offset += 4; 
    controlSocket.write(msg);
  }

  // (B) ADB 路徑 - 為了 100% 點擊成功
  if (action === 0) {
    console.log(`ADB Injecting Tap at: ${finalX}, ${finalY}`);
    exec(`adb -s ${currentSerial} shell input tap ${finalX} ${finalY}`);
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
