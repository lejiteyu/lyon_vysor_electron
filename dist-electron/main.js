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
electron.ipcMain.on("start-mirroring", async (event, device) => {
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
        if (deviceW > 0) mirrorWindow.webContents.send("device-info", { deviceW, deviceH });
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
    child_process.spawn("adb", [
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
      "max_size=800",
      "video_codec=h264",
      "video_bit_rate=4000000",
      "tunnel_forward=false"
    ]);
  } catch (err) {
    console.error("Mirroring failed:", err);
  }
});
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
    msg.writeUInt32BE(action === 1 ? 0 : 1, offset);
    offset += 4;
    controlSocket.write(msg);
  }
  if (action === 0) {
    console.log(`ADB Injecting Tap at: ${finalX}, ${finalY}`);
    child_process.exec(`adb -s ${currentSerial} shell input tap ${finalX} ${finalY}`);
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
