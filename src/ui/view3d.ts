// three.js 三维视图: 厂房、源项、屏蔽体、路径、巡测点渲染与交互

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Project } from '../model/project';
import { ShieldBox, Vec3 } from '../physics/geometry';
import { LineSourceDef, SurfaceSourceDef } from '../model/sources';

const MAT_COLOR: Record<string, number> = {
  concrete: 0x8a8f98, steel: 0x6f9fd8, lead: 0x7a4dbb, water: 0x2f6fd0, air: 0xcccccc,
};

export interface PickResult {
  kind: 'shielding' | 'surface' | 'none';
  point: Vec3;
  objectId?: string;
}

export class View3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private buildingGroup = new THREE.Group();
  private sourceGroup = new THREE.Group();
  private shieldGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private surveyGroup = new THREE.Group();
  private extraGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private container: HTMLElement;
  private raf = 0;
  private disposers: Array<() => void> = [];

  /** 点击回调 (未拖拽时触发) */
  onClick: ((p: PickResult) => void) | null = null;
  /** 屏蔽体拖拽结束回调 */
  onShieldingMoved: ((id: string, center: Vec3) => void) | null = null;
  draggableShielding = false;

  constructor(container: HTMLElement, private project: Project) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 500);
    this.camera.position.set(24, -28, 22);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 3);

    this.scene.background = new THREE.Color(0x0b0f14);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(20, -10, 30);
    this.scene.add(dir);
    this.scene.add(new THREE.GridHelper(40, 40, 0x224, 0x224));
    this.scene.add(new THREE.AxesHelper(3));

    this.scene.add(this.buildingGroup, this.sourceGroup, this.shieldGroup, this.pathGroup, this.surveyGroup, this.extraGroup);
    this.syncAll();
    this.bindPointer();

    const onResize = () => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));

    const tick = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  syncAll(): void {
    this.syncBuilding();
    this.syncSources();
    this.syncShielding();
    this.syncPaths();
    this.syncSurvey();
  }

  private clear(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c);
      (c as THREE.Mesh).geometry?.dispose?.();
    }
  }

  syncBuilding(): void {
    this.clear(this.buildingGroup);
    for (const b of this.project.building.boxes) {
      const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const opacity = b.group === 'structure' ? 0.16 : b.group === 'pipe' ? 0.7 : 0.55;
      const mat = new THREE.MeshLambertMaterial({
        color: MAT_COLOR[b.material] ?? 0x888888,
        transparent: true, opacity,
        depthWrite: b.group !== 'structure',
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      this.buildingGroup.add(mesh);
    }
  }

  syncSources(): void {
    this.clear(this.sourceGroup);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa500 });
    for (const s of this.project.sources) {
      if (s.type === 'point') {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 12), mat);
        m.position.set(s.pos.x, s.pos.y, s.pos.z);
        this.sourceGroup.add(m);
      } else if (s.type === 'line') {
        const pts = (s as LineSourceDef).path.map((p) => new THREE.Vector3(p.x, p.y, p.z));
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xffa500 }),
        );
        this.sourceGroup.add(line);
      } else {
        const b = (s as SurfaceSourceDef).box;
        const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(size.x, size.y, size.z),
          new THREE.MeshBasicMaterial({ color: 0xffa500, wireframe: true }),
        );
        m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
        this.sourceGroup.add(m);
      }
    }
  }

  syncShielding(): void {
    this.clear(this.shieldGroup);
    for (const sc of this.project.scenarios) {
      const active = this.project.activeScenarioIds.includes(sc.id);
      for (const b of sc.boxes) {
        const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size.x, size.y, size.z),
          new THREE.MeshLambertMaterial({
            color: MAT_COLOR[b.material] ?? 0x7a4dbb, transparent: true,
            opacity: active ? 0.85 : 0.25,
          }),
        );
        mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
        mesh.userData = { shieldingId: b.id, scenarioId: sc.id };
        this.shieldGroup.add(mesh);
      }
    }
  }

  syncPaths(): void {
    this.clear(this.pathGroup);
    for (const p of this.project.paths) {
      const pts = [p.start, ...p.segments.map((s) => s.to)];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts.map((q) => new THREE.Vector3(q.x, q.y, q.z))),
        new THREE.LineBasicMaterial({ color: 0x4ade80 }),
      );
      this.pathGroup.add(line);
      pts.forEach((q, i) => {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(i === 0 ? 0.2 : 0.15, 10, 10),
          new THREE.MeshBasicMaterial({ color: i === 0 ? 0x4da3ff : 0x4ade80 }),
        );
        m.position.set(q.x, q.y, q.z);
        this.pathGroup.add(m);
      });
    }
  }

  syncSurvey(): void {
    this.clear(this.surveyGroup);
    for (const sp of this.project.surveyPoints) {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.12),
        new THREE.MeshBasicMaterial({ color: 0xffff66 }),
      );
      m.position.set(sp.pos.x, sp.pos.y, sp.pos.z);
      this.surveyGroup.add(m);
    }
  }

  /** 附加图层 (自动路线、剖切面等), 由页面管理 */
  addExtra(obj: THREE.Object3D): void { this.extraGroup.add(obj); }
  clearExtra(): void { this.clear(this.extraGroup); }

  // ---------- 交互 ----------
  private bindPointer(): void {
    const el = this.renderer.domElement;
    let downAt: [number, number] | null = null;
    let dragging: { id: string; scenarioId: string; mesh: THREE.Mesh } | null = null;

    const pick = (ev: PointerEvent): { point: THREE.Vector3; mesh: THREE.Mesh | null } | null => {
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      if (this.draggableShielding) {
        const hits = this.raycaster.intersectObjects(this.shieldGroup.children, false);
        if (hits.length > 0) return { point: hits[0].point, mesh: hits[0].object as THREE.Mesh };
      }
      const hits = this.raycaster.intersectObjects([this.buildingGroup, this.sourceGroup], true);
      if (hits.length > 0) return { point: hits[0].point, mesh: null };
      // 兜底: 与 z=1 平面求交
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -1);
      const pt = new THREE.Vector3();
      return this.raycaster.ray.intersectPlane(plane, pt) ? { point: pt, mesh: null } : null;
    };

    const onDown = (ev: PointerEvent) => {
      downAt = [ev.clientX, ev.clientY];
      const hit = pick(ev);
      if (this.draggableShielding && hit?.mesh) {
        dragging = { id: hit.mesh.userData.shieldingId, scenarioId: hit.mesh.userData.scenarioId, mesh: hit.mesh };
        this.controls.enabled = false;
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      // 默认在水平面拖动; 按住 Shift 在垂直面拖动
      const z = dragging.mesh.position.z;
      const plane = ev.shiftKey
        ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -dragging.mesh.position.y)
        : new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
      const pt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(plane, pt)) {
        if (ev.shiftKey) dragging.mesh.position.set(pt.x, dragging.mesh.position.y, Math.max(-3.5, pt.z));
        else dragging.mesh.position.set(pt.x, pt.y, z);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (dragging) {
        const p = dragging.mesh.position;
        this.onShieldingMoved?.(dragging.id, { x: p.x, y: p.y, z: p.z });
        dragging = null;
        this.controls.enabled = true;
      } else if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) < 5) {
        const hit = pick(ev);
        if (hit && this.onClick) {
          this.onClick({
            kind: hit.mesh ? 'shielding' : 'surface',
            point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
            objectId: hit.mesh?.userData?.shieldingId,
          });
        }
      }
      downAt = null;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    this.disposers.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
