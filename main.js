import { app, BrowserWindow, ipcMain } from 'electron';
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

ipcMain.on('start-mirroring', async (event, device) => {
  if (isStreaming) return;
  const { serial } = device;

  try {
    if (!mirrorWindow) {
      mirrorWindow = new BrowserWindow({
        width: 450, height: 800, backgroundColor: '#000',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      const url = process.env.VITE_DEV_SERVER_URL ? `${process.env.VITE_DEV_SERVER_URL}mirror.html` : path.join(__dirname, 'dist/mirror.html');
      process.env.VITE_DEV_SERVER_URL ? mirrorWindow.loadURL(url) : mirrorWindow.loadFile(url);
      
      mirrorWindow.on('closed', () => { 
        mirrorWindow = null; isStreaming = false;
        if (tcpServer) { tcpServer.close(); tcpServer = null; }
        videoSocket = null; controlSocket = null;
        exec(`adb -s ${serial} shell pkill -f scrcpy-server`);
      });
    }

    videoSocket = null;
    controlSocket = null;

    if (tcpServer) tcpServer.close();
    tcpServer = net.createServer((socket) => {
      if (!videoSocket) {
        videoSocket = socket;
        console.log('Video socket connected!');
        isStreaming = true;
        if (mirrorWindow) {
          mirrorWindow.webContents.send('stream-reset');
        }
        videoSocket.on('data', (chunk) => {
          if (mirrorWindow) mirrorWindow.webContents.send('video-data', chunk);
        });
      } else {
        controlSocket = socket;
        console.log('Control socket connected! Mouse control ready.');
      }
      socket.on('error', (e) => console.error('Socket error:', e));
    });

    tcpServer.listen(12345, '127.0.0.1');

    console.log('Cleaning up old sessions...');
    if (mirrorWindow) mirrorWindow.webContents.send('streaming-status-update', 'Cleaning up...');
    try { await execAsync(`adb -s ${serial} shell pkill -f scrcpy-server`); } catch(e){}
    try { await execAsync(`adb forward --remove-all`); } catch(e){}
    try { await execAsync(`adb -s ${serial} reverse --remove-all`); } catch(e){}
    
    console.log('Setting up ADB reverse...');
    if (mirrorWindow) mirrorWindow.webContents.send('streaming-status-update', 'Setting up Reverse proxy...');
    await execAsync(`adb -s ${serial} reverse localabstract:scrcpy tcp:12345`);

    console.log('Checking server file...');
    let serverPath = path.join(__dirname, 'scrcpy-server-v2.4.jar');
    if (!fs.existsSync(serverPath)) serverPath = path.join(__dirname, '..', 'scrcpy-server-v2.4.jar');
    
    console.log('Pushing server to device...');
    if (mirrorWindow) mirrorWindow.webContents.send('streaming-status-update', 'Pushing server...');
    await execAsync(`adb -s ${serial} push "${serverPath}" /data/local/tmp/scrcpy-server.jar`);

    console.log('Launching scrcpy-server...');
    if (mirrorWindow) mirrorWindow.webContents.send('streaming-status-update', 'Launching scrcpy-server...');
    spawn('adb', [
      '-s', serial, 'shell', 
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', 
      '2.4', 'scid=-1', 'tunnel_forward=false', 'audio=false', 'control=true', 
      'power_on=false', 'stay_awake=true', 'max_size=800', 'video_codec=h264', 
      'video_bit_rate=4000000', 'i_frame_interval=1', 'log_level=info'
    ]);

  } catch (err) {
    console.error('Failed:', err);
  }
});

/**
 * 處理來自前端的滑鼠控制事件
 * Scrcpy 2.0+ Inject Touch Event (Type 0)
 */
ipcMain.on('inject-touch', (event, { action, x, y, width, height }) => {
  if (!controlSocket) return;

  // 加入偵錯日誌
  console.log(`Control: Action=${action}, X=${x}, Y=${y}, Screen=${width}x${height}`);

  const msg = Buffer.alloc(28);
  let offset = 0;
  msg.writeUInt8(0, offset++); // Type 0
  msg.writeUInt8(action, offset++); // Action
  
  // Pointer ID (8 bytes) - 使用 0 (手指)
  msg.writeBigInt64BE(0n, offset);
  offset += 8;

  msg.writeUInt16BE(width, offset); offset += 2; 
  msg.writeUInt16BE(height, offset); offset += 2;
  msg.writeUInt32BE(x, offset); offset += 4;
  msg.writeUInt32BE(y, offset); offset += 4;
  
  msg.writeUInt16BE(0xffff, offset); offset += 2; // Pressure
  msg.writeUInt32BE(0, offset); offset += 4; // Buttons (手指模式應為 0)
  
  controlSocket.write(msg);
});
