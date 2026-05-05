import React, { useEffect, useRef, useState } from 'react';
import JMuxer from 'jmuxer';
const { ipcRenderer } = window.require('electron');

const MirrorView = () => {
  const videoRef = useRef(null);
  const jmuxerRef = useRef(null);
  const isStarted = useRef(false);
  const headerBuffer = useRef(new Uint8Array(0));

  const [deviceSize, setDeviceSize] = useState({ w: 0, h: 0 });
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
        // 合併緩存
        const newBuffer = new Uint8Array(headerBuffer.current.length + chunk.length);
        newBuffer.set(headerBuffer.current);
        newBuffer.set(chunk, headerBuffer.current.length);
        headerBuffer.current = newBuffer;

        // 當數據量足夠時開始分析
        if (headerBuffer.current.length >= 100) {
          console.log('First 100 bytes (Hex):', Array.from(headerBuffer.current.slice(0, 100)).map(b => b.toString(16).padStart(2, '0')).join(' '));
          
          let startCodeIndex = -1;
          // 搜尋 00 00 00 01 或 00 00 01
          for (let i = 0; i < headerBuffer.current.length - 4; i++) {
            if (headerBuffer.current[i] === 0 && headerBuffer.current[i+1] === 0 && 
                ((headerBuffer.current[i+2] === 0 && headerBuffer.current[i+3] === 1) || 
                 (headerBuffer.current[i+2] === 1))) {
              startCodeIndex = i;
              break;
            }
          }

          if (startCodeIndex !== -1) {
            console.log('Renderer: Found Start Code at index', startCodeIndex);
            const firstPacket = headerBuffer.current.slice(startCodeIndex);
            jmuxerRef.current.feed({ video: firstPacket });
            isStarted.current = true;
            headerBuffer.current = new Uint8Array(0);
          } else {
            console.warn('Renderer: Still searching for start code in', headerBuffer.current.length, 'bytes');
          }
        }
      } else {
        jmuxerRef.current.feed({ video: chunk });
      }
    };

    ipcRenderer.on('video-data', handleVideoData);
    ipcRenderer.on('device-info', (e, size) => setDeviceSize(size));
    ipcRenderer.on('stream-reset', () => { isStarted.current = false; headerBuffer.current = new Uint8Array(0); });

    return () => {
      if (jmuxerRef.current) jmuxerRef.current.destroy();
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
    const x = Math.round(((e.clientX - rect.left) / rect.width) * vW);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * vH);
    const onScreen = (x >= 0 && y >= 0 && x <= vW && y <= vH);
    
    let devX = 'NaN', devY = 'NaN';
    if (onScreen && deviceSize.w > 0) {
      const realMax = Math.max(deviceSize.w, deviceSize.h);
      const realMin = Math.min(deviceSize.w, deviceSize.h);
      if (vW > vH) {
        devX = Math.round((x / vW) * realMax);
        devY = Math.round((y / vH) * realMin);
      } else {
        devX = Math.round((x / vW) * realMin);
        devY = Math.round((y / vH) * realMax);
      }
    }
    setMouseInfo({ x: devX, y: devY, onScreen });

    if (onScreen && (e.type === 'pointerdown' || e.type === 'pointermove' || e.type === 'pointerup')) {
      const actions = { pointerdown: 0, pointerup: 1, pointermove: 2 };
      if (e.buttons === 1 || e.type === 'pointerup') {
        ipcRenderer.send('inject-touch', { action: actions[e.type], x, y, width: vW, height: vH });
      }
    }
  };

  return (
    <div onPointerDown={handlePointer} onPointerMove={handlePointer} onPointerUp={handlePointer}
      style={{ width: '100%', height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#000', overflow: 'hidden', position: 'relative', cursor: mouseInfo.onScreen ? 'crosshair' : 'default' }}>
      <video ref={videoRef} muted autoPlay style={{ maxWidth: '100%', maxHeight: '100%', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '20px', right: '20px', background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '10px', borderRadius: '5px', fontSize: '12px', pointerEvents: 'none', zIndex: 10 }}>
        POS: {mouseInfo.x}, {mouseInfo.y}
      </div>
    </div>
  );
};

export default MirrorView;
