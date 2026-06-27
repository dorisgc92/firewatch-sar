/**
 * App.jsx
 * Top-level layout for FireWatch SAR.
 * Manages module switching (Module 1: Pre-Fire / Module 2: Active Fire)
 * and passes shared data to child components.
 */

import { useState } from 'react'
import { useFireData } from './hooks/useFireData'
import FireMap from './components/FireMap'
import FreshnessPanel from './components/FreshnessPanel'
import Sidebar from './components/Sidebar'

export default function App() {
  const [activeModule, setActiveModule] = useState(2) // Start on Module 2 (active fire)
  const [selectedRegion, setSelectedRegion] = useState(null)
  const layers = useFireData()

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      width: '100vw',
      background: '#0a0a0a',
      color: '#ffffff',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    }}>

      {/* ── TOP BAR ── */}
      <header style={{
        background: '#1a2a3a',
        borderBottom: '2px solid #2e5b8a',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        flexShrink: 0,
        zIndex: 1000,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '24px' }}>🔥</span>
          <span style={{ fontWeight: 'bold', fontSize: '18px', color: '#ffffff' }}>
            FireWatch SAR
          </span>
          <span style={{ fontSize: '11px', color: '#7aafd4', marginLeft: '4px' }}>
            Wildfire Intelligence Platform
          </span>
        </div>

        {/* Module switcher */}
        <div style={{ display: 'flex', gap: '4px', marginLeft: '16px' }}>
          <button
            onClick={() => setActiveModule(1)}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '13px',
              background: activeModule === 1 ? '#2e5b8a' : '#1a2a3a',
              color: activeModule === 1 ? '#ffffff' : '#7aafd4',
              borderBottom: activeModule === 1 ? '2px solid #44aaff' : '2px solid transparent',
            }}
          >
            📊 Module 1: Pre-Fire Risk
          </button>
          <button
            onClick={() => setActiveModule(2)}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '13px',
              background: activeModule === 2 ? '#5a1a00' : '#1a2a3a',
              color: activeModule === 2 ? '#ffffff' : '#cc6644',
              borderBottom: activeModule === 2 ? '2px solid #ff6600' : '2px solid transparent',
            }}
          >
            🛰️ Module 2: Active Fire
          </button>
        </div>

        {/* Active fire count badge */}
        {layers.hotspots?.data && (
          <div style={{
            marginLeft: 'auto',
            background: '#5a0000',
            border: '1px solid #cc3300',
            borderRadius: '12px',
            padding: '4px 10px',
            fontSize: '12px',
            color: '#ffaaaa',
          }}>
            🔴 {layers.hotspots.data.features?.length?.toLocaleString() || 0} active hotspots
          </div>
        )}
      </header>

      {/* ── MAIN CONTENT ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Map — takes most of the screen */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <FireMap
            activeModule={activeModule}
            layers={layers}
            onRegionSelect={setSelectedRegion}
          />
        </div>

        {/* Sidebar — situation summary */}
        <Sidebar
          activeModule={activeModule}
          layers={layers}
          selectedRegion={selectedRegion}
        />
      </div>

      {/* ── FRESHNESS PANEL ── */}
      <FreshnessPanel layers={layers} />
    </div>
  )
}
