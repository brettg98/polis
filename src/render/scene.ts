import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Simulation } from '../engine/sim';
import { RNG } from '../engine/rng';
import type { City } from '../engine/types';

const WORLD_SIZE = 100;
const HEIGHT_SCALE = 20;

const STATUS_COLORS: Record<string, number> = {
  alive: 0x57d98a,
  struggling: 0xf2c14e,
  ruins: 0x777777,
};

interface Marker {
  group: THREE.Group;
  ring: THREE.Mesh;
  buildings: THREE.Mesh[];
  anchor: THREE.Vector3;
}

export class SceneView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private markers = new Map<string, Marker>();
  private tradeLines: THREE.LineSegments | null = null;
  private terrainPositions: THREE.BufferAttribute;
  private gridSize: number;

  constructor(container: HTMLElement, sim: Simulation) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b0e14);
    this.scene.fog = new THREE.Fog(0x0b0e14, WORLD_SIZE * 1.1, WORLD_SIZE * 2.6);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(WORLD_SIZE * 0.62, WORLD_SIZE * 0.55, WORLD_SIZE * 0.62);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.maxDistance = WORLD_SIZE * 1.6;
    this.controls.minDistance = 18;

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(60, 90, 30);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0x8fb4d9, 0x2a2620, 0.75));

    // terrain: displaced plane, flat-shaded, per-face color bands with jitter
    const { size, heights, seaLevel } = sim.terrain;
    this.gridSize = size;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, size - 1, size - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i] * HEIGHT_SCALE);
    this.terrainPositions = pos.clone();

    const flat = geo.toNonIndexed();
    const fpos = flat.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(fpos.count * 3);
    const jitter = new RNG(sim.config.seed + 7);
    const col = new THREE.Color();
    for (let f = 0; f < fpos.count; f += 3) {
      const avg = (fpos.getY(f) + fpos.getY(f + 1) + fpos.getY(f + 2)) / (3 * HEIGHT_SCALE);
      terrainColor(col, avg, seaLevel);
      col.offsetHSL(0, 0, jitter.range(-0.03, 0.03));
      for (let v = 0; v < 3; v++) {
        colors[(f + v) * 3] = col.r;
        colors[(f + v) * 3 + 1] = col.g;
        colors[(f + v) * 3 + 2] = col.b;
      }
    }
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    flat.computeVertexNormals();
    this.scene.add(new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })));

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_SIZE * 3, WORLD_SIZE * 3).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1f5f82, transparent: true, opacity: 0.86, roughness: 0.25, metalness: 0.1 }),
    );
    water.position.y = seaLevel * HEIGHT_SCALE - 0.05;
    this.scene.add(water);

    for (const c of sim.cities) this.addMarker(c);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const loop = (): void => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
    this.update(sim);
  }

  private anchorFor(c: City): THREE.Vector3 {
    const i = c.site.y * this.gridSize + c.site.x;
    return new THREE.Vector3(this.terrainPositions.getX(i), this.terrainPositions.getY(i), this.terrainPositions.getZ(i));
  }

  private addMarker(c: City): void {
    const anchor = this.anchorFor(c);
    const group = new THREE.Group();
    group.position.copy(anchor);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.1, 2.8, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: STATUS_COLORS.alive, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    ring.position.y = 0.25;
    group.add(ring);

    const buildings: THREE.Mesh[] = [];
    const brng = new RNG(hashCode(c.id) + 11);
    for (let k = 0; k < 4; k++) {
      const h = brng.range(1.2, 3.4);
      const b = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, h, 0.9),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(c.color), roughness: 0.6 }),
      );
      b.position.set(brng.range(-1.1, 1.1), h / 2 + 0.1, brng.range(-1.1, 1.1));
      group.add(b);
      buildings.push(b);
    }

    group.add(makeLabel(c.name));
    this.scene.add(group);
    this.markers.set(c.id, { group, ring, buildings, anchor });
  }

  update(sim: Simulation): void {
    for (const c of sim.cities) {
      const m = this.markers.get(c.id)!;
      (m.ring.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLORS[c.status]);
      const s = c.status === 'ruins' ? 0.45 : 0.55 + 0.65 * (c.population / c.startPopulation);
      m.group.scale.setScalar(s);
      if (c.status === 'ruins') {
        for (const b of m.buildings) (b.material as THREE.MeshStandardMaterial).color.setHex(0x555555);
      }
    }

    if (this.tradeLines) {
      this.scene.remove(this.tradeLines);
      this.tradeLines.geometry.dispose();
      (this.tradeLines.material as THREE.Material).dispose();
      this.tradeLines = null;
    }
    const pts: THREE.Vector3[] = [];
    const lift = new THREE.Vector3(0, 2.4, 0);
    for (const ag of sim.activeAgreements()) {
      pts.push(this.markers.get(ag.a)!.anchor.clone().add(lift), this.markers.get(ag.b)!.anchor.clone().add(lift));
    }
    if (pts.length) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      this.tradeLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x6ee7b7, transparent: true, opacity: 0.65 }));
      this.scene.add(this.tradeLines);
    }
  }
}

function terrainColor(out: THREE.Color, h: number, sea: number): void {
  if (h < sea - 0.02) out.set(0x173a52);
  else if (h < sea + 0.015) out.set(0xc7b280);
  else if (h < 0.5) out.set(0x5f9450);
  else if (h < 0.62) out.set(0x497a41);
  else if (h < 0.74) out.set(0x8a8175);
  else out.set(0xe6e7ea);
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function makeLabel(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#f2f4f8';
  ctx.fillText(text, 128, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
  sprite.scale.set(11, 2.75, 1);
  sprite.position.y = 6.5;
  return sprite;
}
