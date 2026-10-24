/**
 * The realms, ported from Rapture Chess (src/scene/realm.ts): Valhalla (the Alliance's hall of stone, gold and aurora)
 * and the Underworld (the Horde's basalt crater with a lava moat). Each is a Blender-built arena GLB plus a sky, fog
 * and lighting preset, and a couple of animated materials (flowing lava, flickering fire).
 *
 * The GLBs are the Rapture Chess arenas with their Draco compression decoded at build time and the meshes quantized
 * (KHR_mesh_quantization), so three.js reads them with no decoder, WebAssembly or worker.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SkyColors, Stage } from './stage';

export type RealmId = 'valhalla' | 'underworld';

interface Preset {
  sky: SkyColors;
  aurora: number;
  stars: number;
  key: { color: number; intensity: number; position: [number, number, number] };
  rim: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  envIntensity: number;
  floorRadius: number;
}

const PRESETS: Record<RealmId, Preset> = {
  valhalla: {
    sky: { top: 0x070b1a, bottom: 0x1a2240, glow: 0x3d5a8a, fog: 0x0a0f1e, fogDensity: 0.02 },
    aurora: 1, stars: 0.9,
    key: { color: 0xfff3e0, intensity: 2.4, position: [6, 12, 5] },
    rim: { color: 0x9fd0ff, intensity: 55 },
    hemi: { sky: 0x4a5a8a, ground: 0x1a1410, intensity: 0.6 },
    envIntensity: 0.6, floorRadius: 9.05,
  },
  underworld: {
    sky: { top: 0x050102, bottom: 0x2a0806, glow: 0x7a1a08, fog: 0x120404, fogDensity: 0.024 },
    aurora: 0, stars: 0.25,
    key: { color: 0xffd0b0, intensity: 1.8, position: [-5, 10, -6] },
    rim: { color: 0xff5a2a, intensity: 70 },
    hemi: { sky: 0x4a1a10, ground: 0x200404, intensity: 0.7 },
    envIntensity: 0.5, floorRadius: 0,
  },
};

/** Multipliers on the textured stone: photo-real stone would otherwise outshine everything in front of it. */
const TINT: Record<string, number> = {
  vh_stone: 0x8e887c, vh_floor: 0x8a8274, vh_blocks: 0x6e675e,
  uw_basalt: 0x3e3236, uw_rock: 0x4e3e3a, uw_ash: 0x5e4e46,
};

export class Realm {
  readonly group = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<RealmId, Promise<THREE.Group | null>>();
  private animated: THREE.ShaderMaterial[] = [];
  private fires: THREE.MeshStandardMaterial[] = [];
  id: RealmId | null = null;

  constructor(private readonly stage: Stage, private readonly base: string) {
    stage.scene.add(this.group);
    stage.onUpdate((dt, t) => this.update(dt, t));
  }

  /** Light the stage for a realm at once, and swap in its arena when the model has loaded (each loads once). */
  async load(id: RealmId): Promise<boolean> {
    if (this.id === id) return true;
    this.id = id;
    const p = PRESETS[id], s = this.stage;
    s.setSky(p.sky, p.aurora, p.stars);
    s.keyLight.color.set(p.key.color); s.keyLight.intensity = p.key.intensity; s.keyLight.position.set(...p.key.position);
    s.rimLight.color.set(p.rim.color); s.rimLight.intensity = p.rim.intensity;
    s.hemi.color.set(p.hemi.sky); s.hemi.groundColor.set(p.hemi.ground); s.hemi.intensity = p.hemi.intensity;
    s.scene.environmentIntensity = p.envIntensity;
    s.setFloorRadius(p.floorRadius);
    let model = this.cache.get(id);
    if (!model) {
      model = this.loader.loadAsync(`${this.base}${id}.glb`).then(async (g) => {
        performance.mark(`arena:${id}:parsed`);
        this.dress(g.scene, id);
        // compile its shaders off the main thread (KHR_parallel_shader_compile) before it is ever drawn, so the first
        // frame with the arena doesn't stall the menu while the driver compiles
        await this.stage.renderer.compileAsync(g.scene, this.stage.camera, this.stage.scene);
        performance.mark(`arena:${id}:compiled`);
        return g.scene;
      }, (e) => { console.warn('[arena] realm failed', id, e); this.cache.delete(id); return null; });
      this.cache.set(id, model);
    }
    const scene = await model;
    if (!scene || this.id !== id) return !!scene;
    this.group.clear();
    this.animated = scene.userData.animated ?? [];
    this.fires = scene.userData.fires ?? [];
    this.group.add(scene);
    return true;
  }

  /** Swap the Blender placeholder materials for the stage's: animated lava, glowing fire, worn stone and metal. */
  private dress(root: THREE.Object3D, id: RealmId): void {
    const mats = new Map<string, THREE.Material>();
    const animated: THREE.ShaderMaterial[] = [], fires: THREE.MeshStandardMaterial[] = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = false;
      o.receiveShadow = false;
      const src = o.material as THREE.MeshStandardMaterial;
      let m = mats.get(src.name);
      if (!m) { m = this.material(src, id, animated, fires); mats.set(src.name, m); }
      o.material = m;
    });
    root.userData.animated = animated;
    root.userData.fires = fires;
  }

  private material(src: THREE.MeshStandardMaterial, id: RealmId, animated: THREE.ShaderMaterial[], fires: THREE.MeshStandardMaterial[]): THREE.Material {
    const n = src.name;
    if (/lava/.test(n)) { const m = lava(); animated.push(m); return m; }
    if (/fire|ember/.test(n)) {
      const m = src.clone();
      m.emissiveIntensity = /fire/.test(n) ? 3.5 : 2.5;
      m.color.set(0x1a0805);
      fires.push(m);
      return m;
    }
    if (/rune/.test(n)) { const m = src.clone(); m.emissiveIntensity = 2.2; m.color.set(0x05050a); return m; }
    if (src.map) {
      // Poly Haven stone, ground and rock: keep the colour and normal maps, darken them to the realm's mood, matte
      const m = src.clone();
      m.color.set(TINT[n] ?? 0x8a8478);
      m.metalnessMap = null; m.roughnessMap = null;
      m.metalness = 0; m.roughness = 0.9; m.envMapIntensity = 0.25;
      return m;
    }
    if (/crystal/.test(n)) { const m = src.clone(); m.emissiveIntensity = 2.6; return m; }
    if (/banner/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x14284a, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    if (/gold/.test(n)) return new THREE.MeshStandardMaterial({ color: 0xffbf5e, roughness: 0.3, metalness: 1, envMapIntensity: 1.2 });
    if (/obsidian/.test(n)) return new THREE.MeshPhysicalMaterial({ color: 0x0a070c, roughness: 0.2, metalness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.25, envMapIntensity: 1.0 });
    if (/bone/.test(n)) return new THREE.MeshStandardMaterial({ color: 0xd8ccb0, roughness: 0.75, metalness: 0 });
    if (/basalt/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x15111a, roughness: 0.9, metalness: 0.08 });
    if (/dark/.test(n)) return new THREE.MeshStandardMaterial({ color: 0x1a1613, roughness: 0.7, metalness: 0.15 });
    return new THREE.MeshStandardMaterial({ color: id === 'valhalla' ? 0x4a443c : 0x2a2226, roughness: 0.92, metalness: 0.05, envMapIntensity: 0.35 });
  }

  private update(_dt: number, t: number): void {
    const fog = this.stage.scene.fog as THREE.FogExp2;
    for (const m of this.animated) { m.uniforms.time.value = t; (m.uniforms.fogColor.value as THREE.Color).copy(fog.color); m.uniforms.fogDensity.value = fog.density; }
    for (let i = 0; i < this.fires.length; i++) this.fires[i].emissiveIntensity = 3.0 + 0.8 * Math.sin(t * 7 + i * 1.7) * Math.sin(t * 3.1 + i);
  }
}

/** Flowing lava: two layers of scrolling noise, hot cracks over a dark crust, emissive enough to bloom. */
function lava(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, hot: { value: new THREE.Color(0xff7a1a) }, crust: { value: new THREE.Color(0x1a0604) }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.02 } },
    vertexShader: 'varying vec3 vW; varying vec2 vUv; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vUv = w.xz * 0.35; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float time; uniform vec3 hot, crust, fogColor; uniform float fogDensity; varying vec3 vW; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.1 + 3.7; a *= 0.5; } return v; }
      void main(){
        vec2 uv = vUv + vec2(time * 0.02, time * 0.012);
        float n = fbm(uv * 2.0 + fbm(uv * 1.5 - time * 0.03) * 1.5);
        float glow = pow(smoothstep(0.42, 0.62, n), 1.6);
        vec3 c = mix(crust, hot * 3.5, glow) + hot * 0.25 * smoothstep(0.3, 0.45, n);
        float d = length(cameraPosition - vW); float f = 1.0 - exp(-fogDensity * fogDensity * d * d);
        gl_FragColor = vec4(mix(c, fogColor, f), 1.0); }`,
  });
}
