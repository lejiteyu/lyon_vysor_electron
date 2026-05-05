"use strict";
const electron = require("electron");
const path = require("path");
const url = require("url");
const child_process = require("child_process");
const util = require("util");
const net = require("net");
const fs = require("fs");
var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
const execAsync = util.promisify(child_process.exec);
const __filename$1 = url.fileURLToPath(typeof document === "undefined" ? require("url").pathToFileURL(__filename).href : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || new URL("main.js", document.baseURI).href);
const __dirname$1 = path.dirname(__filename$1);
let mainWindow;
let mirrorWindow;
let isStreaming = false;
let tcpServer = null;
let videoSocket = null;
let controlSocket = null;
let connectionCount = 0;
let currentSerial = "";
let deviceW = 0;
let deviceH = 0;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1100,
    height: 850,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f172a",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname$1, "dist/index.html"));
  }
}
electron.app.whenReady().then(createWindow);
electron.ipcMain.handle("get-devices", async () => {
  try {
    const { stdout } = await execAsync("adb devices -l");
    const lines = stdout.trim().split("\n").slice(1);
    return lines.map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      const modelMatch = line.match(/model:(\S+)/);
      return {
        serial: parts[0],
        status: parts[1],
        model: modelMatch ? modelMatch[1].replace(/_/g, " ") : "Unknown Device"
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
});
electron.ipcMain.on("start-mirroring", async (event, { device, maxSize = 800 }) => {
  if (isStreaming) return;
  currentSerial = device.serial;
  const { serial } = device;
  try {
    try {
      const { stdout: sizeOut } = await execAsync(`adb -s ${serial} shell wm size`);
      const sizeMatch = sizeOut.match(/(\d+)x(\d+)/g);
      if (sizeMatch) {
        const [w, h] = sizeMatch[sizeMatch.length - 1].split("x").map(Number);
        deviceW = w;
        deviceH = h;
      }
    } catch (e) {
    }
    if (!mirrorWindow) {
      mirrorWindow = new electron.BrowserWindow({
        width: 500,
        height: 850,
        backgroundColor: "#000",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      const baseUrl = process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname$1, "dist/index.html")}`;
      mirrorWindow.loadURL(`${baseUrl}#/mirror`);
      mirrorWindow.on("closed", () => {
        mirrorWindow = null;
        isStreaming = false;
        if (tcpServer) {
          tcpServer.close();
          tcpServer = null;
        }
        videoSocket = null;
        controlSocket = null;
        connectionCount = 0;
        child_process.exec(`adb -s ${serial} shell pkill -f scrcpy-server`);
      });
      mirrorWindow.webContents.on("did-finish-load", () => {
        mirrorWindow.webContents.send("device-info", { deviceW, deviceH });
        if (deviceW > 0 && deviceH > 0) {
          const ratio = deviceW / deviceH;
          const windowH = 850;
          const videoH = windowH - 70;
          const windowW = Math.round(videoH * ratio);
          const finalW = Math.max(350, Math.min(windowW, 1e3));
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
        if (mirrorWindow) mirrorWindow.webContents.send("stream-reset");
        videoSocket.on("data", (chunk) => {
          if (mirrorWindow) mirrorWindow.webContents.send("video-data", chunk);
        });
      } else if (connectionCount === 2) {
        controlSocket = socket;
        controlSocket.on("data", (data) => {
          try {
            if (data[0] === 0 && data.length > 5) {
              const textLength = data.readUInt32BE(1);
              const text = data.slice(5, 5 + textLength).toString("utf8");
              if (text) electron.clipboard.writeText(text);
            }
          } catch (err) {
          }
        });
      }
    });
    tcpServer.listen(12345, "127.0.0.1");
    try {
      await execAsync(`adb -s ${serial} shell pkill -f scrcpy-server`);
    } catch (e) {
    }
    try {
      await execAsync(`adb -s ${serial} reverse localabstract:scrcpy tcp:12345`);
    } catch (e) {
    }
    let serverPath = path.join(__dirname$1, "scrcpy-server-v2.4.jar");
    if (!fs.existsSync(serverPath)) serverPath = path.join(__dirname$1, "..", "scrcpy-server-v2.4.jar");
    await execAsync(`adb -s ${serial} push "${serverPath}" /data/local/tmp/scrcpy-server.jar`);
    const scrcpyProcess = child_process.spawn("adb", [
      "-s",
      serial,
      "shell",
      "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      "2.4",
      "video=true",
      "audio=false",
      "control=true",
      `max_size=${maxSize}`,
      "video_codec=h264",
      "video_bit_rate=4000000",
      "max_fps=60",
      "tunnel_forward=false"
    ]);
    scrcpyProcess.stdout.on("data", (data) => console.log(`[Scrcpy Server]: ${data}`));
    scrcpyProcess.stderr.on("data", (data) => console.error(`[Scrcpy Error]: ${data}`));
  } catch (err) {
    console.error("Mirroring failed:", err);
  }
});
electron.ipcMain.on("restart-mirror", (event) => {
  if (currentSerial) {
    console.log("Restarting mirror for", currentSerial);
    isStreaming = false;
    connectionCount = 0;
    electron.ipcMain.emit("start-mirroring", event, { device: { serial: currentSerial }, maxSize: 1024 });
  }
});
let scrollAccumulator = 0;
let lastScrollTime = 0;
electron.ipcMain.on("inject-scroll", (event, { x, y, width, height, deltaX, deltaY }) => {
  if (!currentSerial) return;
  if (controlSocket) {
    const msg = Buffer.alloc(21);
    let offset = 0;
    msg.writeUInt8(3, offset++);
    msg.writeInt32BE(x, offset);
    offset += 4;
    msg.writeInt32BE(y, offset);
    offset += 4;
    msg.writeUInt16BE(width, offset);
    offset += 2;
    msg.writeUInt16BE(height, offset);
    offset += 2;
    msg.writeInt32BE(Math.round(-deltaX), offset);
    offset += 4;
    msg.writeInt32BE(Math.round(-deltaY), offset);
    offset += 4;
    controlSocket.write(msg);
  }
  scrollAccumulator += deltaY;
  const now = Date.now();
  if (Math.abs(scrollAccumulator) >= 100 || now - lastScrollTime > 200 && Math.abs(scrollAccumulator) > 20) {
    const swipeDistance = scrollAccumulator;
    scrollAccumulator = 0;
    lastScrollTime = now;
    const startX = Math.round(deviceW / 2);
    const startY = Math.round(deviceH / 2);
    const endY = Math.round(startY - swipeDistance);
    console.log(`ADB Scroll Fallback: Swiping ${swipeDistance}px`);
    child_process.exec(`adb -s ${currentSerial} shell input swipe ${startX} ${startY} ${startX} ${endY} 150`);
  }
});
let lastDownX = 0;
let lastDownY = 0;
let lastDownTime = 0;
let longPressTimer = null;
electron.ipcMain.on("inject-touch", (event, { action, x, y, width, height }) => {
  if (!currentSerial || deviceW === 0) return;
  let finalX, finalY;
  const realMax = Math.max(deviceW, deviceH);
  const realMin = Math.min(deviceW, deviceH);
  if (width > height) {
    finalX = Math.round(x / width * realMax);
    finalY = Math.round(y / height * realMin);
  } else {
    finalX = Math.round(x / width * realMin);
    finalY = Math.round(y / height * realMax);
  }
  if (action === 0) {
    lastDownX = finalX;
    lastDownY = finalY;
    lastDownTime = Date.now();
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      console.log(`ADB Fallback: Long Press detected at ${finalX}, ${finalY}`);
      child_process.exec(`adb -s ${currentSerial} shell input swipe ${finalX} ${finalY} ${finalX} ${finalY} 1000`);
      longPressTimer = null;
    }, 600);
  }
  if (action === 2) {
    const dx = finalX - lastDownX;
    const dy = finalY - lastDownY;
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  }
  if (controlSocket) {
    const msg = Buffer.alloc(28);
    let offset = 0;
    msg.writeUInt8(2, offset++);
    msg.writeUInt8(action, offset++);
    msg.writeBigInt64BE(0n, offset);
    offset += 8;
    msg.writeInt32BE(x, offset);
    offset += 4;
    msg.writeInt32BE(y, offset);
    offset += 4;
    msg.writeUInt16BE(width, offset);
    offset += 2;
    msg.writeUInt16BE(height, offset);
    offset += 2;
    msg.writeUInt16BE(action === 1 ? 0 : 65535, offset);
    offset += 2;
    msg.writeUInt32BE(0, offset);
    offset += 4;
    controlSocket.write(msg);
  }
  if (action === 1) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    const dx = finalX - lastDownX;
    const dy = finalY - lastDownY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - lastDownTime;
    if (distance < 10 && duration < 600) {
      console.log(`ADB Fallback: Tap at ${finalX}, ${finalY}`);
      child_process.exec(`adb -s ${currentSerial} shell input tap ${finalX} ${finalY}`);
    } else if (distance >= 10) {
      console.log(`ADB Fallback: Swipe from ${lastDownX},${lastDownY} to ${finalX},${finalY}`);
      child_process.exec(`adb -s ${currentSerial} shell input swipe ${lastDownX} ${lastDownY} ${finalX} ${finalY} 200`);
    }
  }
});
electron.ipcMain.on("set-clipboard", (event, text) => {
  if (controlSocket && text) {
    const textBuf = Buffer.from(text, "utf8");
    const msg = Buffer.alloc(1 + 8 + 1 + 4 + textBuf.length);
    let offset = 0;
    msg.writeUInt8(9, offset++);
    msg.writeBigInt64BE(0n, offset);
    offset += 8;
    msg.writeUInt8(1, offset++);
    msg.writeUInt32BE(textBuf.length, offset);
    offset += 4;
    textBuf.copy(msg, offset);
    controlSocket.write(msg);
    console.log("Synced clipboard to device:", text);
  }
});
electron.ipcMain.on("send-key", (event, keycode) => {
  if (controlSocket) {
    const msg = Buffer.alloc(14);
    msg.writeUInt8(0, 0);
    msg.writeUInt8(0, 1);
    msg.writeUInt32BE(keycode, 2);
    msg.writeUInt32BE(0, 6);
    msg.writeUInt32BE(0, 10);
    controlSocket.write(msg);
    msg.writeUInt8(1, 1);
    controlSocket.write(msg);
    if (keycode === 3 || keycode === 4 || keycode === 187) {
      console.log(`ADB Injecting Keyevent: ${keycode}`);
      child_process.exec(`adb -s ${currentSerial} shell input keyevent ${keycode}`);
    }
    console.log("Sent Keycode:", keycode);
  }
});
