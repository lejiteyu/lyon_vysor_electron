import React, { useEffect, useRef, useState } from 'react';
import JMuxer from 'jmuxer';
const { ipcRenderer, clipboard } = window.require('electron');

const MirrorView = () => {
  const videoRef = useRef(null);
  const jmuxerRef = useRef(null);
  const isStarted = useRef(false);
  const headerBuffer = useRef(new Uint8Array(0));

  const [deviceInfo, setDeviceInfo] = useState({ deviceW: 0, deviceH: 0 });
  const [mouseInfo, setMouseInfo] = useState({ x: 'NaN', y: 'NaN', onScreen: false });

  useEffect(() => {
    jmuxerRef.current = new JMuxer({
      node: videoRef.current,
      mode: 'video',
      flushingTime: 0,
      fps: 60,
      debug: false
    });

    const handleVideoData = (event, data) => {
      const chunk = new Uint8Array(data);

      if (!isStarted.current) {
        const newBuffer = new Uint8Array(headerBuffer.current.length + chunk.length);
        newBuffer.set(headerBuffer.current);
        newBuffer.set(chunk, headerBuffer.current.length);
        headerBuffer.current = newBuffer;

        if (headerBuffer.current.length >= 100) {
          let startCodeIndex = -1;
          for (let i = 0; i < headerBuffer.current.length - 4; i++) {
            if (headerBuffer.current[i] === 0 && headerBuffer.current[i+1] === 0 && 
                ((headerBuffer.current[i+2] === 0 && headerBuffer.current[i+3] === 1) || 
                 (headerBuffer.current[i+2] === 1))) {
              startCodeIndex = i;
              break;
            }
          }

          if (startCodeIndex !== -1) {
            const firstPacket = headerBuffer.current.slice(startCodeIndex);
            jmuxerRef.current.feed({ video: firstPacket });
            isStarted.current = true;
            headerBuffer.current = new Uint8Array(0);
          }
        }
      } else {
        jmuxerRef.current.feed({ video: chunk });
      }
    };

    const handleKeyDown = (e) => {
      // 偵測 Ctrl+V 或 Cmd+V
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        const text = clipboard.readText();
        if (text) {
          console.log('Renderer: Pasting text to device', text);
          ipcRenderer.send('set-clipboard', text);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    ipcRenderer.on('video-data', handleVideoData);
    ipcRenderer.on('device-info', (e, info) => {
      console.log('Renderer: Received device info', info);
      setDeviceInfo(info);
    });
    ipcRenderer.on('stream-reset', () => { isStarted.current = false; headerBuffer.current = new Uint8Array(0); });

    return () => {
      if (jmuxerRef.current) jmuxerRef.current.destroy();
      window.removeEventListener('keydown', handleKeyDown);
      ipcRenderer.removeAllListeners('video-data');
      ipcRenderer.removeAllListeners('device-info');
      ipcRenderer.removeAllListeners('stream-reset');
    };
  }, []);

  const handlePointer = (e) => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;
    const rect = videoRef.current.getBoundingClientRect();
    const vW = videoRef.current.videoWidth;
    const vH = videoRef.current.videoHeight;

    // 計算相對於影片內容的座標 (0-vW, 0-vH)
    const x = Math.round(((e.clientX - rect.left) / rect.width) * vW);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * vH);
    const onScreen = (x >= 0 && y >= 0 && x <= vW && y <= vH);
    
    let devX = 'NaN', devY = 'NaN';
    if (onScreen && deviceInfo.deviceW > 0) {
      const realMax = Math.max(deviceInfo.deviceW, deviceInfo.deviceH);
      const realMin = Math.min(deviceInfo.deviceW, deviceInfo.deviceH);
      // 根據影片比例換算手機物理座標
      if (vW > vH) {
        devX = Math.round((x / vW) * realMax);
        devY = Math.round((y / vH) * realMin);
      } else {
        devX = Math.round((x / vW) * realMin);
        devY = Math.round((y / vH) * realMax);
      }
    }
    setMouseInfo({ x: devX, y: devY, onScreen });

    if (onScreen) {
      const actions = { pointerdown: 0, pointerup: 1, pointermove: 2 };
      if (e.type === 'pointerdown' || e.type === 'pointerup' || (e.type === 'pointermove' && e.buttons === 1)) {
        ipcRenderer.send('inject-touch', { action: actions[e.type], x, y, width: vW, height: vH });
      }
    }
  };

  const sendKey = (code) => {
    ipcRenderer.send('send-key', code);
  };

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', background: '#000', overflow: 'hidden' }}>
      
      {/* 上方：鏡像影片區域 */}
      <div onPointerDown={handlePointer} onPointerMove={handlePointer} onPointerUp={handlePointer}
        style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', cursor: mouseInfo.onScreen ? 'crosshair' : 'default' }}>
        <video ref={videoRef} muted autoPlay style={{ maxWidth: '100%', maxHeight: '100%', pointerEvents: 'none' }} />
        
        {/* 座標顯示 (放在影片區域左下角) */}
        <div style={{ position: 'absolute', bottom: '10px', left: '10px', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '5px 10px', borderRadius: '4px', fontSize: '10px', pointerEvents: 'none', fontFamily: 'monospace' }}>
          POS: {mouseInfo.x}, {mouseInfo.y}
        </div>
      </div>

      {/* 下方：導航按鈕列 (獨立區域，不重疊) */}
      <div style={{ height: '70px', background: '#1e293b', borderTop: '1px solid #334155', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '30px', padding: '0 20px', zIndex: 100 }}>
        <NavButton icon="↩" label="Back" onClick={() => sendKey(4)} />
        <NavButton icon="⌂" label="Home" onClick={() => sendKey(3)} />
        <NavButton icon="▢" label="Recents" onClick={() => sendKey(187)} />
        <div style={{ width: '1px', height: '30px', background: '#475569' }} />
        <NavButton icon="↻" label="Refresh" onClick={() => ipcRenderer.send('restart-mirror')} />
        <div style={{ width: '1px', height: '30px', background: '#475569' }} />
        <NavButton icon="−" label="Vol-" onClick={() => sendKey(25)} />
        <NavButton icon="+" label="Vol+" onClick={() => sendKey(24)} />
        <NavButton icon="⏻" label="Power" onClick={() => sendKey(26)} />
      </div>

    </div>
  );
};

// 導航按鈕組件
const NavButton = ({ icon, label, onClick }) => (
  <button 
    onClick={onClick}
    title={label}
    style={{ 
      width: '45px', height: '45px', borderRadius: '12px', border: 'none', 
      background: 'rgba(255,255,255,0.05)', color: '#cbd5e1', fontSize: '20px', cursor: 'pointer',
      display: 'flex', justifyContent: 'center', alignItems: 'center', transition: 'all 0.2s',
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
    }}
    onMouseOver={(e) => {
      e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
      e.currentTarget.style.color = '#fff';
    }}
    onMouseOut={(e) => {
      e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
      e.currentTarget.style.color = '#cbd5e1';
    }}
  >
    {icon}
  </button>
);

export default MirrorView;
