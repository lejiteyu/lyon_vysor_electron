import React, { useState, useEffect } from 'react';
import MirrorView from './mirror';
const { ipcRenderer } = window.require('electron');

function App() {
  const [route, setRoute] = useState(window.location.hash || '#/');
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', handleHashChange);
    refreshDevices();
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const refreshDevices = async () => {
    setLoading(true);
    const list = await ipcRenderer.invoke('get-devices');
    setDevices(list);
    setLoading(false);
  };

  const [maxSize, setMaxSize] = useState(1024);

  const startMirroring = (device) => {
    ipcRenderer.send('start-mirroring', { device, maxSize });
  };

  // 鏡像路由 (必須保留，否則無法切換畫面)
  if (route.startsWith('#/mirror')) {
    return <MirrorView />;
  }

  return (
    <div style={{ 
      padding: '40px', color: '#fff', minHeight: '100vh', 
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
        <div>
          <h1 style={{ fontSize: '32px', fontWeight: '800', margin: 0, letterSpacing: '-0.5px' }}>
            Lyon Vysor Self
          </h1>
          <p style={{ color: '#94a3b8', marginTop: '8px' }}>Manage and mirror your Android devices</p>
        </div>
        <button 
          onClick={refreshDevices}
          style={{
            padding: '10px 20px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.05)', color: '#fff', cursor: 'pointer'
          }}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '24px' }}>
        {devices.map(device => (
          <div key={device.serial} style={{
            padding: '24px', borderRadius: '16px', background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.05)', backdropFilter: 'blur(10px)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ 
                width: '48px', height: '48px', borderRadius: '12px', background: '#38bdf822',
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '16px'
              }}>
                <span style={{ fontSize: '24px' }}>📱</span>
              </div>
              <div>
                <div style={{ fontWeight: '600', fontSize: '18px' }}>{device.model}</div>
                <div style={{ color: '#64748b', fontSize: '14px' }}>{device.serial}</div>
              </div>
            </div>
            
            {/* 解析度選擇器 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '5px' }}>Resolution</label>
              <select 
                value={maxSize} 
                onChange={(e) => setMaxSize(Number(e.target.value))}
                style={{ 
                  width: '100%', padding: '8px', borderRadius: '8px', background: '#1e293b', 
                  color: '#fff', border: '1px solid #334155', outline: 'none' 
                }}
              >
                <option value={800}>800 (Fluent)</option>
                <option value={1024}>1024 (Standard)</option>
                <option value={1280}>1280 (High Definition)</option>
                <option value={1600}>1600 (Super Clear)</option>
                <option value={1920}>1920 (Ultra HD)</option>
              </select>
            </div>

            <button 
              onClick={() => startMirroring(device)}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: 'linear-gradient(to right, #0ea5e9, #2563eb)',
                color: '#fff', border: 'none', fontWeight: '600', cursor: 'pointer'
              }}
            >
              Start Mirroring
            </button>
          </div>
        ))}
      </div>

      {devices.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: '100px', color: '#64748b' }}>
          No devices found. Connect your Android via USB.
        </div>
      )}
    </div>
  );
}

export default App;
