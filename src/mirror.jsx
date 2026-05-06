import React, { useEffect, useRef, useState } from 'react';
import JMuxer from 'jmuxer';
const { ipcRenderer, clipboard } = window.require('electron');

const MirrorView = () => {
  const videoRef = useRef(null);
  const jmuxerRef = useRef(null);
  const containerRef = useRef(null);
  const isStarted = useRef(false);
  const headerBuffer = useRef(new Uint8Array(0));

  const [deviceInfo, setDeviceInfo] = useState({ deviceW: 1080, deviceH: 2400 });
  const [mouseInfo, setMouseInfo] = useState({ x: 0, y: 0, onScreen: false });

  const [logs, setLogs] = useState([]);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [isLogPaused, setIsLogPaused] = useState(false);
  const isLogPausedRef = useRef(false);
  const logEndRef = useRef(null);

  // 同步 Ref 狀態
  useEffect(() => {
    isLogPausedRef.current = isLogPaused;
  }, [isLogPaused]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.focus();

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

    const handleDeviceLog = (event, log) => {
      // 使用 Ref 判斷，避免 useEffect 重啟
      if (isLogPausedRef.current) return;
      setLogs(prev => {
        const newLogs = [...prev, ...log.split('\n')].filter(line => line.trim());
        return newLogs.slice(-500);
      });
    };

    ipcRenderer.on('video-data', handleVideoData);
    ipcRenderer.on('device-info', (e, info) => {
      if (info.deviceW && info.deviceH) setDeviceInfo(info);
    });
    ipcRenderer.on('stream-reset', () => { isStarted.current = false; headerBuffer.current = new Uint8Array(0); });
    ipcRenderer.on('device-log', handleDeviceLog);

    return () => {
      if (jmuxerRef.current) jmuxerRef.current.destroy();
      ipcRenderer.removeAllListeners('video-data');
      ipcRenderer.removeAllListeners('device-info');
      ipcRenderer.removeAllListeners('stream-reset');
      ipcRenderer.removeAllListeners('device-log');
    };
  }, []); // 依賴項設為空，保證 JMuxer 只初始化一次

  useEffect(() => {
    if (isLogOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isLogOpen]);

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      const text = clipboard.readText();
      if (text) ipcRenderer.send('set-clipboard', text);
      return;
    }

    const specialKeys = {
      'Enter': 66,
      'Backspace': 67,
      'Tab': 61,
      'Escape': 4,
      'ArrowUp': 19,
      'ArrowDown': 20,
      'ArrowLeft': 21,
      'ArrowRight': 22,
    };

    if (specialKeys[e.key]) {
      e.preventDefault();
      ipcRenderer.send('send-key', specialKeys[e.key]);
      return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      ipcRenderer.send('inject-text', e.key);
    }
  };

  const handlePointer = (e) => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;
    const rect = videoRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * videoRef.current.videoWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * videoRef.current.videoHeight);
    setMouseInfo({ x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y, onScreen: true });

    const actions = { pointerdown: 0, pointerup: 1, pointermove: 2 };
    if (e.type === 'pointerdown' || e.type === 'pointerup' || (e.type === 'pointermove' && e.buttons === 1)) {
      ipcRenderer.send('inject-touch', { 
        action: actions[e.type], 
        x, y, 
        width: videoRef.current.videoWidth, 
        height: videoRef.current.videoHeight 
      });
    }
  };

  const handleWheel = (e) => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;
    const rect = videoRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * videoRef.current.videoWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * videoRef.current.videoHeight);

    ipcRenderer.send('inject-scroll', {
      x, y, width: videoRef.current.videoWidth, height: videoRef.current.videoHeight,
      deltaX: e.deltaX, deltaY: e.deltaY
    });
  };

  const filteredLogs = logs.filter(line => 
    line.toLowerCase().includes(logFilter.toLowerCase())
  );

  return (
    <div 
      ref={containerRef}
      tabIndex={0} 
      autoFocus
      onKeyDown={handleKeyDown}
      onPointerDown={() => containerRef.current && containerRef.current.focus()}
      style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', background: '#000', overflow: 'hidden', outline: 'none' }}
    >
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div 
          onPointerDown={handlePointer} onPointerMove={handlePointer} onPointerUp={handlePointer} onWheel={handleWheel}
          style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', cursor: mouseInfo.onScreen ? 'crosshair' : 'default', background: '#000' }}
        >
          <video ref={videoRef} muted autoPlay style={{ maxWidth: '100%', maxHeight: '100%', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: '10px', left: '10px', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '5px 10px', borderRadius: '4px', fontSize: '10px', pointerEvents: 'none', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span>POS: {mouseInfo.x}, {mouseInfo.y}</span>
            <span>BUF: {videoRef.current?.videoWidth}x{videoRef.current?.videoHeight}</span>
            <span>DEV: {deviceInfo.deviceW}x{deviceInfo.deviceH}</span>
          </div>
        </div>

        {isLogOpen && (
          <div style={{ 
            width: '400px', background: '#0f172a', borderLeft: '1px solid #334155', 
            display: 'flex', flexDirection: 'column', fontSize: '11px', color: '#94a3b8',
            fontFamily: 'monospace'
          }}>
            <div style={{ padding: '10px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#fff', fontWeight: 'bold' }}>Device Logcat</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => setIsLogPaused(!isLogPaused)} style={{ background: isLogPaused ? '#f43f5e' : '#334155', border: 'none', color: '#fff', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '10px' }}>
                    {isLogPaused ? '▶ Resume' : '⏸ Pause'}
                  </button>
                  <button onClick={() => setLogs([])} style={{ background: '#334155', border: 'none', color: '#fff', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '10px' }}>Clear</button>
                </div>
              </div>
              <input 
                type="text" 
                placeholder="Filter logs (e.g. ActivityManager)..."
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                style={{ 
                  width: '100%', background: '#0f172a', border: '1px solid #334155', 
                  borderRadius: '4px', color: '#fff', padding: '5px 8px', fontSize: '11px',
                  outline: 'none'
                }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {filteredLogs.map((line, i) => (
                <div key={i} style={{ marginBottom: '4px', borderBottom: '1px solid #1e293b', paddingBottom: '2px', color: line.includes('E/') ? '#f43f5e' : (line.includes('W/') ? '#fbbf24' : '#94a3b8') }}>
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      <div style={{ 
        minHeight: '70px', background: '#1e293b', borderTop: '1px solid #334155', 
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '15px', padding: '10px', zIndex: 100 
      }}>
        <div style={{ display: 'flex', gap: '15px' }}>
          <NavButton icon="↩" label="返回" onClick={() => ipcRenderer.send('send-key', 4)} />
          <NavButton icon="⌂" label="首頁" onClick={() => ipcRenderer.send('send-key', 3)} />
          <NavButton icon="▢" label="最近任務" onClick={() => ipcRenderer.send('send-key', 187)} />
        </div>
        <div style={{ width: '1px', height: '30px', background: '#475569' }} />
        <div style={{ display: 'flex', gap: '15px' }}>
          <NavButton icon="📜" label="裝置日誌" onClick={() => setIsLogOpen(!isLogOpen)} active={isLogOpen} />
          <NavButton icon="↻" label="重新整理" onClick={() => ipcRenderer.send('restart-mirror')} />
        </div>
        <div style={{ width: '1px', height: '30px', background: '#475569' }} />
        <div style={{ display: 'flex', gap: '15px' }}>
          <NavButton icon="−" label="降低音量" onClick={() => ipcRenderer.send('send-key', 25)} />
          <NavButton icon="+" label="提高音量" onClick={() => ipcRenderer.send('send-key', 24)} />
          <NavButton icon="⏻" label="電源鍵" onClick={() => ipcRenderer.send('send-key', 26)} />
        </div>
      </div>
    </div>
  );
};

const NavButton = ({ icon, label, onClick, active = false }) => (
  <button onClick={onClick} title={label} style={{ 
      width: '45px', height: '45px', borderRadius: '12px', border: 'none', 
      background: active ? 'rgba(99, 102, 241, 0.3)' : 'rgba(255,255,255,0.05)', 
      color: active ? '#fff' : '#cbd5e1', 
      fontSize: '20px', cursor: 'pointer',
      display: 'flex', justifyContent: 'center', alignItems: 'center', transition: 'all 0.2s',
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
    }}
    onMouseOver={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = '#fff'; }}
    onMouseOut={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = active ? '#fff' : '#cbd5e1'; }}
  >
    {icon}
  </button>
);

export default MirrorView;
