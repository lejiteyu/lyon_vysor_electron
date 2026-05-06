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

ipcMain.on('start-mirroring', async (event, { device, maxSize = 1024 }) => {
  if (isStreaming) return;
  currentSerial = device.serial;
  const { serial } = device;

  try {
    // 取得設備解析度
    try {
      const { stdout: sizeOut } = await execAsync(`adb -s ${serial} shell wm size`);
      const sizeMatch = sizeOut.match(/(\d+)x(\d+)/g);
      if (sizeMatch) {
        const [w, h] = sizeMatch[sizeMatch.length - 1].split('x').map(Number);
        deviceW = w;
        deviceH = h;
        console.log(`Device physical resolution: ${deviceW}x${deviceH}`);
      }
    } catch(e){ console.error('Failed to get device size:', e); }

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

        // 智慧型視窗縮放 (支援橫向電視與縱向手機)
        if (deviceW > 0 && deviceH > 0) {
          const ratio = deviceW / deviceH;
          let finalW, finalH;
          
          if (ratio > 1.2) { // 橫屏裝置 (如電視)
            finalW = 1000;
            const videoW = finalW - 40; 
            const videoH = Math.round(videoW / ratio);
            finalH = videoH + 80; 
          } else { // 縱屏裝置 (如手機)
            finalH = 850;
            const videoH = finalH - 100;
            finalW = Math.max(350, Math.round(videoH * ratio));
          }
          
          mirrorWindow.setSize(finalW, finalH);
          mirrorWindow.center();
          console.log(`Resized mirror window for TV/Phone: ${finalW}x${finalH} (Ratio: ${ratio})`);
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
            // 雙向剪貼簿：從設備複製到電腦
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

    // 啟動 scrcpy 伺服器 (加入編碼器相容性參數與電視支援)
    const scrcpyArgs = [
      '-s', serial, 'shell', 
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', 
      '2.4', 'scid=-1', 'video=true', 'audio=false', 'control=true', `max_size=${maxSize}`, 
      'video_codec=h264', 'video_bit_rate=2000000', 'max_fps=60', 'tunnel_forward=false', 'clipboard_autosync=true'
    ];
    
    console.log('Launching Scrcpy Server with args:', scrcpyArgs.join(' '));
    const scrcpyProcess = spawn('adb', scrcpyArgs);

    scrcpyProcess.stdout.on('data', (data) => console.log(`[Scrcpy Server]: ${data}`));
    scrcpyProcess.stderr.on('data', (data) => console.error(`[Scrcpy Error]: ${data}`));

  } catch (err) {
    console.error('Mirroring failed:', err);
  }
});

ipcMain.on('restart-mirror', (event) => {
  if (currentSerial) {
    console.log('Restarting mirror for', currentSerial);
    isStreaming = false;
    connectionCount = 0;
    ipcMain.emit('start-mirroring', event, { device: { serial: currentSerial }, maxSize: 1024 });
  }
});

let scrollAccumulator = 0;
let lastScrollTime = 0;

ipcMain.on('inject-scroll', (event, { x, y, width, height, deltaX, deltaY }) => {
  if (!currentSerial || deviceW === 0) return;
  scrollAccumulator += deltaY;
  const now = Date.now();
  if (Math.abs(scrollAccumulator) >= 100 || (now - lastScrollTime > 200 && Math.abs(scrollAccumulator) > 20)) {
    const swipeDistance = scrollAccumulator;
    scrollAccumulator = 0;
    lastScrollTime = now;
    const startX = Math.round(deviceW / 2);
    const startY = Math.round(deviceH / 2);
    const endY = Math.round(startY - swipeDistance);
    exec(`adb -s ${currentSerial} shell input swipe ${startX} ${startY} ${startX} ${endY} 150`);
  }
});

let lastDownX = 0;
let lastDownY = 0;
let lastDownTime = 0;
let longPressTimer = null;

ipcMain.on('inject-touch', (event, { action, x, y, width, height }) => {
  if (!currentSerial || deviceW === 0) return;

  const finalX = Math.round((x / width) * deviceW);
  const finalY = Math.round((y / height) * deviceH);

  if (action === 0) { // ACTION_DOWN
    lastDownX = finalX; lastDownY = finalY; lastDownTime = Date.now();
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      console.log(`ADB Long Press: ${finalX}, ${finalY}`);
      exec(`adb -s ${currentSerial} shell input swipe ${finalX} ${finalY} ${finalX} ${finalY} 1000`);
      longPressTimer = null;
    }, 600);
  }

  if (action === 2) { // ACTION_MOVE
    const dx = finalX - lastDownX; const dy = finalY - lastDownY;
    if (Math.sqrt(dx * dx + dy * dy) > 10 && longPressTimer) {
      clearTimeout(longPressTimer); longPressTimer = null;
    }
  }

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

  if (action === 1) { // ACTION_UP
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    const dx = finalX - lastDownX; const dy = finalY - lastDownY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - lastDownTime;
    if (distance < 10 && duration < 600) {
      exec(`adb -s ${currentSerial} shell input tap ${finalX} ${finalY}`);
    } else if (distance >= 10) {
      exec(`adb -s ${currentSerial} shell input swipe ${lastDownX} ${lastDownY} ${finalX} ${finalY} 200`);
    }
  }
});

ipcMain.on('inject-text', (event, text) => {
  if (!currentSerial || !text) return;
  let adbText = text.replace(/ /g, '%s').replace(/([&<>|;()!#*?~^`"'$])/g, '\\$1');
  if (adbText) exec(`adb -s ${currentSerial} shell input text "${adbText}"`);
});

ipcMain.on('set-clipboard', (event, text) => {
  if (!currentSerial || !text) return;
  let adbText = text.replace(/ /g, '%s').replace(/([&<>|;()!#*?~^`"'$])/g, '\\$1');
  if (adbText) exec(`adb -s ${currentSerial} shell input text "${adbText}"`);
});

ipcMain.on('send-key', (event, keycode) => {
  if (controlSocket) {
    const msg = Buffer.alloc(14);
    msg.writeUInt8(0, 0); msg.writeUInt8(0, 1);
    msg.writeUInt32BE(keycode, 2); msg.writeUInt32BE(0, 6); msg.writeUInt32BE(0, 10);
    controlSocket.write(msg);
    msg.writeUInt8(1, 1); controlSocket.write(msg);
    if (keycode === 3 || keycode === 4 || keycode === 187) {
      exec(`adb -s ${currentSerial} shell input keyevent ${keycode}`);
    }
  }
});
