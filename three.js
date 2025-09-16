/*
BackroomsThreeJS.jsx
Single-file React + R3F demo implementing a Backrooms-like experience with a very large, procedurally-generated map.

How to run:
1. Create a new React app (Vite recommended):
   npx create-vite@latest backrooms --template react
   cd backrooms
2. Install dependencies:
   npm install three @react-three/fiber @react-three/drei simplex-noise use-immer
3. Replace src/App.jsx with this file, then run:
   npm run dev

Notes:
- This is a large-scale demo focused on procedural map, instancing for performance, fog & lighting, first-person controls, simple collision, and soundtrack hooks.
- Tune MAP_WIDTH / MAP_HEIGHT for "gigantesque" sizes. The generation uses instanced geometry so it scales significantly better than naive meshes.
- Add enemies, AI, or networking as follow-ups.
*/

import React, { Suspense, useRef, useState, useMemo, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, PointerLockControls, Stats, useTexture, Stars } from '@react-three/drei'
import * as THREE from 'three'
import SimplexNoise from 'simplex-noise'
import { useImmer } from 'use-immer'

// ----------------- CONFIG -----------------
const MAP_WIDTH = 160 // increase for more gigantic map
const MAP_HEIGHT = 160
const CELL_SIZE = 10
const SEED = 42
const WALL_HEIGHT = 3
const CORRIDOR_PROB = 0.45 // how open the map is

// ----------------- UTIL -----------------
function rng(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ t >>> 15, 1 | t)
    r ^= r + Math.imul(r ^ r >>> 7, 61 | r)
    return ((r ^ r >>> 14) >>> 0) / 4294967296
  }
}

function buildMap(width, height, seed) {
  const snoise = new SimplexNoise(String(seed))
  const grid = new Uint8Array(width * height) // 0 = empty, 1 = wall
  const rand = rng(seed)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Edges filled
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        grid[y * width + x] = 1
        continue
      }
      // Noise + random threshold to create organic corridors
      const n = snoise.noise2D(x / 20, y / 20) * 0.5 + 0.5
      const r = rand()
      grid[y * width + x] = (n + r * 0.6 > CORRIDOR_PROB) ? 0 : 1
    }
  }
  // Optional: carve a guaranteed path from center to edge
  // ... left as exercise
  return grid
}

// Convert cell coordinates to world position
const cellToWorld = (x, y) => [ (x - MAP_WIDTH / 2) * CELL_SIZE, 0, (y - MAP_HEIGHT / 2) * CELL_SIZE ]

// ----------------- SCENE COMPONENTS -----------------
function InstancedWalls({ map, width, height }) {
  const meshRef = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const total = width * height

  // material + texture
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 }), [])

  useEffect(() => {
    if (!meshRef.current) return
    let i = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x
        if (map[index] === 1) {
          const [wx, wy, wz] = cellToWorld(x, y)
          dummy.position.set(wx, WALL_HEIGHT / 2, wz)
          dummy.scale.set(CELL_size_safety(), WALL_HEIGHT, CELL_SIZE)
          dummy.updateMatrix()
          meshRef.current.setMatrixAt(i++, dummy.matrix)
        }
      }
    }
    meshRef.current.count = Math.max(0, meshRef.current.count || 0)
    meshRef.current.instanceMatrix.needsUpdate = true
  }, [map, width, height, dummy])

  // helper: ensure cell size fallback
  function CELL_size_safety() { return Math.max(0.001, CELL_SIZE) }

  return (
    <instancedMesh ref={meshRef} args={[null, null, total]} castShadow>
      <boxBufferGeometry args={[1, 1, 1]} />
      <meshStandardMaterial attach="material" roughness={0.9} metalness={0.02} />
    </instancedMesh>
  )
}

function Floor({ width, height }) {
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow>
      <planeBufferGeometry args={[width * CELL_SIZE, height * CELL_SIZE, 1, 1]} />
      <meshStandardMaterial attach="material" side={THREE.DoubleSide} roughness={1} metalness={0} />
    </mesh>
  )
}

function Player({ map, width, height }) {
  const ref = useRef()
  const { camera, gl } = useThree()
  const pos = useRef(new THREE.Vector3(0, 1.6, 0))
  const vel = useRef(new THREE.Vector3())
  const speed = 8
  const keys = useRef({})

  useEffect(() => {
    const onKey = (e) => { keys.current[e.code] = e.type === 'keydown' }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  }, [])

  useFrame((_, dt) => {
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)
    forward.y = 0
    forward.normalize()
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), forward).normalize()

    let move = new THREE.Vector3()
    if (keys.current['KeyW']) move.add(forward)
    if (keys.current['KeyS']) move.sub(forward)
    if (keys.current['KeyA']) move.sub(right)
    if (keys.current['KeyD']) move.add(right)
    if (move.lengthSq() > 0) move.normalize()

    // basic acceleration
    vel.current.lerp(move.multiplyScalar(speed), 0.2)
    pos.current.addScaledVector(vel.current, dt)

    // simple collision: stay within bounds and avoid walls
    const cx = Math.floor((pos.current.x / CELL_SIZE) + width/2)
    const cy = Math.floor((pos.current.z / CELL_SIZE) + height/2)
    if (cx < 1 || cy < 1 || cx >= width-1 || cy >= height-1) {
      // clamp to center area
      pos.current.x = Math.max(-(width/2-2)*CELL_SIZE, Math.min((width/2-2)*CELL_SIZE, pos.current.x))
      pos.current.z = Math.max(-(height/2-2)*CELL_SIZE, Math.min((height/2-2)*CELL_SIZE, pos.current.z))
    }
    // naive wall collision check (push back)
    const checkRadius = 1.6
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox
        const ny = cy + oy
        const idx = ny * width + nx
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && map[idx] === 1) {
          const [wx, , wz] = cellToWorld(nx, ny)
          const dx = pos.current.x - wx
          const dz = pos.current.z - wz
          const dist = Math.hypot(dx, dz)
          const minDist = (CELL_SIZE/2) + checkRadius
          if (dist < minDist && dist > 0.001) {
            const push = (minDist - dist)
            pos.current.x += (dx / dist) * push
            pos.current.z += (dz / dist) * push
          }
        }
      }
    }

    // update camera position
    camera.position.copy(pos.current).y = 1.6
    ref.current && (ref.current.position.copy(pos.current))
  })

  return (
    <group ref={ref}>
      {/* invisible capsule or indicator for debugging */}
    </group>
  )
}

function Ambience() {
  // ambient flickering lights, hum sound placeholder
  const lightRef = useRef()
  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (lightRef.current) lightRef.current.intensity = 0.6 + Math.sin(t * 2.3) * 0.08
  })
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight ref={lightRef} intensity={0.7} position={[10,20,10]} castShadow />
    </>
  )
}

function FogAndEffects() {
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.FogExp2(0xe6e6d8, 0.0020)
    return () => { scene.fog = null }
  }, [scene])
  return null
}

// ----------------- UI Overlay -----------------
function HUD({ seed }) {
  return (
    <div className="absolute top-4 left-4 text-white text-sm font-mono p-2 bg-black bg-opacity-20 rounded">
      <div>Backrooms demo — seed: {seed}</div>
      <div className="text-xs opacity-80">WASD to move, mouse to look (click to lock)</div>
    </div>
  )
}

// ----------------- MAIN APP -----------------
export default function BackroomsThreeJSApp() {
  const [map, setMap] = useImmer(null)
  const [seed, setSeed] = useState(SEED)

  useEffect(() => {
    const m = buildMap(MAP_WIDTH, MAP_HEIGHT, seed)
    setMap(() => m)
  }, [seed, setMap])

  return (
    <div className="w-screen h-screen bg-black relative">
      <HUD seed={seed} />
      <Canvas shadows camera={{ position: [0,1.6,0], fov: 75 }}>
        <Suspense fallback={null}>
          <FogAndEffects />
          <Ambience />
          <Stars distance={200} saturation={0} count={0} />
          <pointLight position={[0,10,0]} intensity={0.2} />

          {map && <InstancedWalls map={map} width={MAP_WIDTH} height={MAP_HEIGHT} />}
          <Floor width={MAP_WIDTH} height={MAP_HEIGHT} />
          <Player map={map || new Uint8Array(0)} width={MAP_WIDTH} height={MAP_HEIGHT} />

          <PointerLockControls />
          <OrbitControls enabled={false} />
        </Suspense>
      </Canvas>

      <div className="absolute right-4 bottom-4 text-xs text-white/80 p-2 bg-black bg-opacity-10 rounded">
        Map: {MAP_WIDTH} x {MAP_HEIGHT} cells — cell size: {CELL_SIZE}
      </div>
    </div>
  )
}


