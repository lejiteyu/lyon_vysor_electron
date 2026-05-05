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
  const { serial } = device;
  try {
    if (!mirrorWindow) {
      mirrorWindow = new electron.BrowserWindow({
        width: 450,
        height: 800,
        backgroundColor: "#000",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      const url2 = process.env.VITE_DEV_SERVER_URL ? `${process.env.VITE_DEV_SERVER_URL}mirror.html` : path.join(__dirname$1, "dist/mirror.html");
      process.env.VITE_DEV_SERVER_URL ? mirrorWindow.loadURL(url2) : mirrorWindow.loadFile(url2);
      mirrorWindow.on("closed", () => {
        mirrorWindow = null;
        isStreaming = false;
        if (tcpServer) {
          tcpServer.close();
          tcpServer = null;
        }
        videoSocket = null;
        controlSocket = null;
        child_process.exec(`adb -s ${serial} shell pkill -f scrcpy-server`);
      });
    }
    videoSocket = null;
    controlSocket = null;
    if (tcpServer) tcpServer.close();
    tcpServer = net.createServer((socket) => {
      if (!videoSocket) {
        videoSocket = socket;
        console.log("Video socket connected!");
        isStreaming = true;
        if (mirrorWindow) {
          mirrorWindow.webContents.send("stream-reset");
        }
        videoSocket.on("data", (chunk) => {
          if (mirrorWindow) mirrorWindow.webContents.send("video-data", chunk);
        });
      } else {
        controlSocket = socket;
        console.log("Control socket connected! Mouse control ready.");
      }
      socket.on("error", (e) => console.error("Socket error:", e));
    });
    tcpServer.listen(12345, "127.0.0.1");
    console.log("Cleaning up old sessions...");
    if (mirrorWindow) mirrorWindow.webContents.send("streaming-status-update", "Cleaning up...");
    try {
      await execAsync(`adb -s ${serial} shell pkill -f scrcpy-server`);
    } catch (e) {
    }
    try {
      await execAsync(`adb forward --remove-all`);
    } catch (e) {
    }
    try {
      await execAsync(`adb -s ${serial} reverse --remove-all`);
    } catch (e) {
    }
    console.log("Setting up ADB reverse...");
    if (mirrorWindow) mirrorWindow.webContents.send("streaming-status-update", "Setting up Reverse proxy...");
    await execAsync(`adb -s ${serial} reverse localabstract:scrcpy tcp:12345`);
    console.log("Checking server file...");
    let serverPath = path.join(__dirname$1, "scrcpy-server-v2.4.jar");
    if (!fs.existsSync(serverPath)) serverPath = path.join(__dirname$1, "..", "scrcpy-server-v2.4.jar");
    console.log("Pushing server to device...");
    if (mirrorWindow) mirrorWindow.webContents.send("streaming-status-update", "Pushing server...");
    await execAsync(`adb -s ${serial} push "${serverPath}" /data/local/tmp/scrcpy-server.jar`);
    console.log("Launching scrcpy-server...");
    if (mirrorWindow) mirrorWindow.webContents.send("streaming-status-update", "Launching scrcpy-server...");
    child_process.spawn("adb", [
      "-s",
      serial,
      "shell",
      "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      "2.4",
      "scid=-1",
      "tunnel_forward=false",
      "audio=false",
      "control=true",
      "power_on=false",
      "stay_awake=true",
      "max_size=800",
      "video_codec=h264",
      "video_bit_rate=4000000",
      "i_frame_interval=1",
      "log_level=info"
    ]);
  } catch (err) {
    console.error("Failed:", err);
  }
});
electron.ipcMain.on("inject-touch", (event, { action, x, y, width, height }) => {
  if (!controlSocket) return;
  console.log(`Control: Action=${action}, X=${x}, Y=${y}, Screen=${width}x${height}`);
  const msg = Buffer.alloc(28);
  let offset = 0;
  msg.writeUInt8(0, offset++);
  msg.writeUInt8(action, offset++);
  msg.writeBigInt64BE(0n, offset);
  offset += 8;
  msg.writeUInt16BE(width, offset);
  offset += 2;
  msg.writeUInt16BE(height, offset);
  offset += 2;
  msg.writeUInt32BE(x, offset);
  offset += 4;
  msg.writeUInt32BE(y, offset);
  offset += 4;
  msg.writeUInt16BE(65535, offset);
  offset += 2;
  msg.writeUInt32BE(0, offset);
  offset += 4;
  controlSocket.write(msg);
});
