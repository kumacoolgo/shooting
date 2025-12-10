import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0';

// ===================== 0. 全局常量 =====================
const _tempVec3 = new THREE.Vector3();
const _zoomTargetWorldPos = new THREE.Vector3(0, 0, 80);
const FORCE_NO_SKELETON = new URLSearchParams(location.search).has('noskel');

// ===================== 1. 性能自适应 =====================
function getPerfProfile() {
    const saved = localStorage.getItem('jt_perf_profile');
    if (saved && ['low', 'medium', 'high'].includes(saved)) return { mode: saved, source: 'MANUAL' };

    const ua = navigator.userAgent || "";
    const isMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua);
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;

    if (isMobile || cores <= 4 || mem <= 4) return { mode: 'low', source: 'AUTO' };
    if (cores >= 8 && mem >= 8 && !isMobile) return { mode: 'high', source: 'AUTO' };
    return { mode: 'medium', source: 'AUTO' };
}
const CURRENT_PROFILE_INFO = getPerfProfile();
const PERF_PROFILE = CURRENT_PROFILE_INFO.mode;
console.log(`🚀 Performance: ${PERF_PROFILE.toUpperCase()} (${CURRENT_PROFILE_INFO.source})`);

const CONFIG = (() => {
    if (PERF_PROFILE === 'low') {
        return { goldCount: 200, silverCount: 200, gemCount: 150, emeraldCount: 150, dustCount: 500, treeHeight: 120, maxRadius: 55, bloomStrength: 0 };
    } else if (PERF_PROFILE === 'high') {
        return { goldCount: 650, silverCount: 650, gemCount: 450, emeraldCount: 450, dustCount: 1300, treeHeight: 120, maxRadius: 55, bloomStrength: 0.6 };
    }
    return { goldCount: 400, silverCount: 400, gemCount: 250, emeraldCount: 250, dustCount: 800, treeHeight: 120, maxRadius: 55, bloomStrength: 0.4 };
})();

const USE_POSTPROCESS = PERF_PROFILE !== 'low';
const GESTURE_FRAME_SKIP = PERF_PROFILE === 'low' ? 3 : (PERF_PROFILE === 'medium' ? 2 : 1);
const MAX_PHOTOS = PERF_PROFILE === 'low' ? 5 : 12;

// ===================== 2. 全局状态 =====================
const STATE = { TREE: 'tree', SCATTER: 'scatter', ZOOM: 'zoom' };
let currentState = STATE.TREE;

let scene, camera, renderer, composer;
let mainGroup = new THREE.Group();
let goldMesh, silverMesh, gemMesh, emeraldMesh, dustSystem;
let photoMeshes = [];
let zoomTargetIndex = -1;
let logicData = { gold: [], silver: [], gem: [], emerald: [], dust: [] };

const dummy = new THREE.Object3D();
let time = 0;

// 手势变量
let handPos = { x: 0, y: 0 };
let lastHandPos = { x: 0, y: 0 };
let isHandPresent = false;

// 物理变量
let rotationVelocity = { x: 0, y: 0 };

let fistHoldFrames = 0;
let isPaused = false;
let gestureFrameCounter = 0;

// ===================== 3. 初始化 =====================
function safeCheckWebGL() {
    try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
}

function initThree() {
    if (!safeCheckWebGL()) {
        document.getElementById('loading').style.display = 'none';
        const s = document.getElementById('status-text');
        if (s) s.innerText = '❌ 设备不支持 WebGL';
        return;
    }

    const container = document.getElementById('canvas-container');
    const width = window.innerWidth;
    const height = window.innerHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020202);

    camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    updateCameraPosition(); 

    renderer = new THREE.WebGLRenderer({ antialias: PERF_PROFILE !== 'low', powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    updatePixelRatio();
    container.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const spotLight = new THREE.SpotLight(0xffddaa, 80);
    spotLight.position.set(30, 60, 50);
    spotLight.angle = Math.PI / 4;
    scene.add(spotLight);
    scene.add(new THREE.PointLight(0xaaddff, 40, 100).translateY(-20).translateX(-30).translateZ(30));
    
    if (USE_POSTPROCESS) {
        const renderScene = new RenderPass(scene, camera);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.5, 0.4, 0.85);
        bloomPass.threshold = 0.4;
        bloomPass.strength = CONFIG.bloomStrength;
        bloomPass.radius = 0.5;
        composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);
    }

    createMaterialsAndMeshes();
    createDust();
    createStarField();

    scene.add(mainGroup);
    window.addEventListener('resize', onWindowResize);
    
    // 【iOS 修复核心】页面可见性变化时，强制检查视频状态
    document.addEventListener('visibilitychange', () => { 
        isPaused = document.hidden;
        if (!document.hidden) {
            const video = document.getElementById("input-video");
            // 如果回到页面发现视频暂停了，尝试播放
            if (video && video.paused && video.srcObject) {
                video.play().catch(e => console.log("iOS Resume:", e));
            }
        }
    });
    
    initUI();
}

function updateCameraPosition() {
    const aspect = window.innerWidth / window.innerHeight;
    if (aspect < 0.6) camera.position.z = 240; 
    else if (aspect < 0.8) camera.position.z = 200;
    else if (aspect < 1.2) camera.position.z = 160;
    else camera.position.z = 130;
}

function updatePixelRatio() {
    const maxDPR = PERF_PROFILE === 'high' ? 1.5 : (PERF_PROFILE === 'medium' ? 1.25 : 1.0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDPR));
}

function initUI() {
    const badge = document.getElementById('perf-badge');
    if(badge) {
        const label = CURRENT_PROFILE_INFO.source === 'AUTO' ? 'AUTO' : PERF_PROFILE.toUpperCase();
        badge.innerText = label;
        const colors = { low: '#ff4444', medium: '#d4af37', high: '#00ff88' };
        badge.style.borderColor = colors[PERF_PROFILE];
        badge.style.color = colors[PERF_PROFILE];
        badge.onclick = () => {
            const modes = ['low', 'medium', 'high', 'auto'];
            const currentIdx = CURRENT_PROFILE_INFO.source === 'AUTO' ? 3 : modes.indexOf(PERF_PROFILE);
            const nextIdx = (currentIdx + 1) % modes.length;
            const nextMode = modes[nextIdx];

            if (nextMode === 'auto') {
                localStorage.removeItem('jt_perf_profile');
                alert('已切换为：自动模式 (重启生效)');
            } else {
                localStorage.setItem('jt_perf_profile', nextMode);
                alert(`已切换为：${nextMode.toUpperCase()} (重启生效)`);
            }
            location.reload();
        };
    }
}

// ===================== 4. 资源创建 =====================
function createMaterialsAndMeshes() {
    const common = { clearcoat: 1.0, emissiveIntensity: 0.1 };
    const goldMat = new THREE.MeshPhysicalMaterial({ color: 0xffaa00, metalness: 1.0, roughness: 0.15, emissive: 0xaa5500, ...common });
    const silverMat = new THREE.MeshPhysicalMaterial({ color: 0xeeeeee, metalness: 0.9, roughness: 0.2, emissive: 0x222222, ...common });
    const gemMat = new THREE.MeshPhysicalMaterial({ color: 0xff0044, metalness: 0.1, roughness: 0.0, transmission: 0.5, thickness: 1.0, emissive: 0x440011, emissiveIntensity: 0.3 });
    const emeraldMat = new THREE.MeshPhysicalMaterial({ color: 0x00aa55, metalness: 0.2, roughness: 0.1, transmission: 0.4, thickness: 1.5, emissive: 0x002211, emissiveIntensity: 0.2 });

    const sphereGeo = new THREE.SphereGeometry(0.7, 10, 10);
    const boxGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const diamondGeo = new THREE.OctahedronGeometry(0.8, 0);
    const coneGeo = new THREE.ConeGeometry(0.5, 1.2, 5); 

    goldMesh = createInstancedMesh(sphereGeo, goldMat, CONFIG.goldCount, logicData.gold);
    silverMesh = createInstancedMesh(boxGeo, silverMat, CONFIG.silverCount, logicData.silver);
    gemMesh = createInstancedMesh(diamondGeo, gemMat, CONFIG.gemCount, logicData.gem);
    emeraldMesh = createInstancedMesh(coneGeo, emeraldMat, CONFIG.emeraldCount, logicData.emerald);

    const star = new THREE.Mesh(new THREE.OctahedronGeometry(3.0, 0), new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness:0.8, roughness:0, emissive:0xffffee, emissiveIntensity:1 }));
    star.userData = { treePos: new THREE.Vector3(0, CONFIG.treeHeight/2 + 2, 0), scatterPos: new THREE.Vector3(0, 60, 0) };
    star.position.copy(star.userData.treePos);
    mainGroup.add(star);
    logicData.star = star;
}

function createInstancedMesh(geo, mat, count, dataArray) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mainGroup.add(mesh);
    for (let i = 0; i < count; i++) {
        const h = Math.random() * CONFIG.treeHeight - CONFIG.treeHeight/2;
        const normH = (h + CONFIG.treeHeight/2) / CONFIG.treeHeight;
        const rMax = CONFIG.maxRadius * (1 - normH);
        const r = Math.sqrt(Math.random()) * rMax; 
        const theta = Math.random() * Math.PI * 2;
        const treePos = new THREE.Vector3(r * Math.cos(theta), h, r * Math.sin(theta));
        dataArray.push({
            treePos: treePos,
            scatterPos: randomSpherePoint(40 + Math.random()*40),
            currentPos: treePos.clone(),
            scale: 0.6 + Math.random() * 0.8,
            rotSpeed: new THREE.Euler(Math.random()*0.03, Math.random()*0.03, Math.random()*0.03),
            rotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, 0)
        });
    }
    return mesh;
}

function randomSpherePoint(r) {
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
}

function createDust() {
    const geo = new THREE.BufferGeometry();
    const pos = [];
    for(let i=0; i<CONFIG.dustCount; i++) {
        const h = Math.random() * CONFIG.treeHeight - CONFIG.treeHeight/2;
        const r = Math.random() * CONFIG.maxRadius * (1 - (h + CONFIG.treeHeight/2)/CONFIG.treeHeight) + 2; 
        const theta = Math.random() * Math.PI * 2;
        const x = r*Math.cos(theta), y = h, z = r*Math.sin(theta);
        pos.push(x, y, z);
        logicData.dust.push({ treePos: new THREE.Vector3(x, y, z), scatterPos: randomSpherePoint(60), currentPos: new THREE.Vector3(x, y, z) });
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    dustSystem = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffee, size: 0.6, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    mainGroup.add(dustSystem);
}

function createStarField() {
    const geo = new THREE.BufferGeometry();
    const pos = [];
    for(let i=0; i<800; i++) pos.push((Math.random()-0.5)*1000, (Math.random()-0.5)*1000, (Math.random()-0.5)*1000);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({color: 0x888888, size: 1.2, transparent: true, opacity: 0.5}));
    scene.add(stars);
}

// ===================== 5. 动画与物理逻辑 =====================
function animate() {
    requestAnimationFrame(animate);
    if(isPaused) return;
    time += 0.01;

    updateInstancedMesh(goldMesh, logicData.gold);
    updateInstancedMesh(silverMesh, logicData.silver);
    updateInstancedMesh(gemMesh, logicData.gem);
    updateInstancedMesh(emeraldMesh, logicData.emerald);
    updateDust();
    updatePhotos();
    
    if (logicData.star) {
        let target = currentState === STATE.TREE ? logicData.star.userData.treePos : logicData.star.userData.scatterPos;
        logicData.star.position.lerp(target, 0.05);
        logicData.star.rotation.y += 0.01;
    }

    if (currentState === STATE.ZOOM) {
        rotationVelocity.x = 0; rotationVelocity.y = 0;
    } 
    else if (currentState === STATE.SCATTER) {
        // --- 物理引擎 ---
        if (isHandPresent) {
            const deltaX = handPos.x - lastHandPos.x;
            const deltaY = handPos.y - lastHandPos.y;

            // 1. 推力 (Sensitivity 1.3)
            if (Math.abs(deltaX) > 0.001 || Math.abs(deltaY) > 0.001) {
                rotationVelocity.y += deltaX * 1.5; 
                rotationVelocity.x += deltaY * 1.5;
            }
            lastHandPos.x = handPos.x;
            lastHandPos.y = handPos.y;
        }

        // 2. 阻尼 (0.95)
        rotationVelocity.y *= 0.99; 
        rotationVelocity.x *= 0.98;

        // 3. 限速 (0.05)
        const MAX_SPEED = 0.05;
        rotationVelocity.y = Math.max(Math.min(rotationVelocity.y, MAX_SPEED), -MAX_SPEED);
        rotationVelocity.x = Math.max(Math.min(rotationVelocity.x, MAX_SPEED), -MAX_SPEED);

        // 4. 应用
        mainGroup.rotation.y += rotationVelocity.y;
        mainGroup.rotation.x += rotationVelocity.x;
        mainGroup.rotation.x *= 0.98; 

    } else if (currentState === STATE.TREE) {
        mainGroup.rotation.y += 0.003;
        mainGroup.rotation.x *= 0.95;
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
}

function updateInstancedMesh(mesh, dataArray) {
    for (let i = 0; i < dataArray.length; i++) {
        const item = dataArray[i];
        let target = currentState === STATE.TREE ? item.treePos : item.scatterPos;
        if(currentState === STATE.ZOOM) target = item.scatterPos;
        if (currentState === STATE.SCATTER) item.currentPos.y += Math.sin(time + i)*0.005;

        item.currentPos.lerp(target, 0.08);
        item.rotation.x += item.rotSpeed.x;
        item.rotation.y += item.rotSpeed.y;

        let s = item.scale;
        if(currentState === STATE.ZOOM) s = item.scale * 0.6; 
        dummy.position.copy(item.currentPos);
        dummy.rotation.copy(item.rotation);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
}

function updateDust() {
    const positions = dustSystem.geometry.attributes.position.array;
    for(let i=0; i<logicData.dust.length; i++) {
        const item = logicData.dust[i];
        let target = currentState === STATE.TREE ? item.treePos : item.scatterPos;
        if(currentState !== STATE.TREE) item.currentPos.lerp(target, 0.05);
        else {
            item.currentPos.y += 0.05;
            if(item.currentPos.y > CONFIG.treeHeight/2) item.currentPos.y = -CONFIG.treeHeight/2;
            const normH = (item.currentPos.y + CONFIG.treeHeight/2) / CONFIG.treeHeight;
            const rMax = CONFIG.maxRadius * (1-normH) + 2;
            const rCurr = Math.sqrt(item.currentPos.x**2 + item.currentPos.z**2);
            if(rCurr > rMax) { item.currentPos.x *= 0.98; item.currentPos.z *= 0.98; }
        }
        positions[i*3] = item.currentPos.x; positions[i*3+1] = item.currentPos.y; positions[i*3+2] = item.currentPos.z;
    }
    dustSystem.geometry.attributes.position.needsUpdate = true;
}

function updatePhotos() {
    const camPos = camera.position;
    photoMeshes.forEach((mesh, idx) => {
        let targetPos, targetScale = 2.0; 
        if (currentState === STATE.SCATTER) {
            targetScale = 8.0; mesh.lookAt(camPos); 
        }
        if (currentState === STATE.ZOOM && idx === zoomTargetIndex) {
            _tempVec3.copy(_zoomTargetWorldPos);
            targetPos = mainGroup.worldToLocal(_tempVec3);
            targetScale = 12.0;
            mesh.lookAt(camPos); 
        } else {
            targetPos = currentState === STATE.TREE ? mesh.userData.treePos : mesh.userData.scatterPos;
            if(currentState !== STATE.TREE) mesh.position.y += Math.sin(time+idx)*0.01;
            if (currentState === STATE.TREE) {
                mesh.rotation.copy(mesh.userData.baseRot);
                mesh.rotation.y += 0.01;
            }
        }
        mesh.position.lerp(targetPos, 0.1);
        mesh.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.1);
    });
}

// ===================== 6. 手势识别 =====================
async function setupMediaPipe() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        document.getElementById('status-text').innerText = "❌ 浏览器不支持摄像头";
        document.getElementById('loading').style.display = 'none';
        return;
    }
    try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm");
        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, delegate: "GPU" },
            runningMode: "VIDEO", numHands: 1
        });
        const video = document.getElementById("input-video");
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: {ideal: 320}, height: {ideal: 240} } })
            .then((stream) => {
                video.srcObject = stream;
                video.addEventListener("loadeddata", () => {
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('status-text').innerText = `就绪 (${PERF_PROFILE.toUpperCase()})`;
                    predictWebcam(handLandmarker, video);
                });
            }).catch(err => { document.getElementById('status-text').innerText = "❌ 摄像头失败 (需HTTPS)"; });
    } catch(e) { console.error(e); }
}

let lastVideoTime = -1;
async function predictWebcam(handLandmarker, video) {
    if(isPaused) { requestAnimationFrame(() => predictWebcam(handLandmarker, video)); return; }
    gestureFrameCounter = (gestureFrameCounter + 1) % GESTURE_FRAME_SKIP;
    if (gestureFrameCounter !== 0) { requestAnimationFrame(() => predictWebcam(handLandmarker, video)); return; }
    
    // 【iOS 唤醒保护】如果在循环检测中发现视频暂停了，尝试强制播放
    if (video.paused && video.srcObject && !document.hidden) {
        video.play().catch(()=>{});
    }

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const result = handLandmarker.detectForVideo(video, performance.now());
        const canvas = document.getElementById('skeleton-canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (result.landmarks && result.landmarks.length > 0) {
            const landmarks = result.landmarks[0];
            isHandPresent = true;
            if(PERF_PROFILE !== 'low' && !FORCE_NO_SKELETON) drawSkeleton(ctx, landmarks, canvas.width, canvas.height);
            handleGesture(landmarks);
        } else { isHandPresent = false; }
    }
    requestAnimationFrame(() => predictWebcam(handLandmarker, video));
}

function handleGesture(landmarks) {
    const palmX = 1 - (landmarks[0].x + landmarks[9].x) / 2;
    const palmY = (landmarks[0].y + landmarks[9].y) / 2;
    
    handPos.x = handPos.x * 0.8 + palmX * 0.2;
    handPos.y = handPos.y * 0.8 + palmY * 0.2;

    let bentFingers = 0;
    const tips = [8, 12, 16, 20], pips = [6, 10, 14, 18], wrist = landmarks[0];
    tips.forEach((tipIdx, i) => {
        const dTip = Math.hypot(landmarks[tipIdx].x - wrist.x, landmarks[tipIdx].y - wrist.y);
        const dPip = Math.hypot(landmarks[pips[i]].x - wrist.x, landmarks[pips[i]].y - wrist.y);
        if (dTip < dPip) bentFingers++;
    });

    const pinchDist = Math.hypot(landmarks[4].x - landmarks[8].x, landmarks[4].y - landmarks[8].y);
    
    const isFistState = bentFingers >= 3;
    const isPinchState = !isFistState && pinchDist < 0.05;

    if (isFistState) fistHoldFrames++; else fistHoldFrames = 0;
    const isConfirmedFist = fistHoldFrames > 6; 

    const status = document.getElementById('status-text');

    if (isPinchState && currentState === STATE.SCATTER) {
        if (photoMeshes.length > 0) {
            currentState = STATE.ZOOM;
            status.innerHTML = "📸 <span style='color:#ffd700'>抓取照片</span>";
            if (zoomTargetIndex === -1 && photoMeshes.length > 0) {
                let minDist = Infinity; let bestIdx = 0;
                const camPos = camera.position; 
                photoMeshes.forEach((mesh, idx) => {
                    mesh.getWorldPosition(_tempVec3);
                    const d = _tempVec3.distanceTo(camPos);
                    if (d < minDist) { minDist = d; bestIdx = idx; }
                });
                zoomTargetIndex = bestIdx;
            }
        } else { status.innerHTML = "⚠ <span style='color:#aaa'>请先上传照片</span>"; }
    } 
    else if (isConfirmedFist) {
        currentState = STATE.TREE; zoomTargetIndex = -1;
        status.innerHTML = "🎄 <span style='color:#00ff00'>聚合圣诞树</span>";
    } 
    else {
        if(currentState === STATE.ZOOM && !isPinchState) { currentState = STATE.SCATTER; zoomTargetIndex = -1; } 
        else if (currentState === STATE.TREE) { currentState = STATE.SCATTER; lastHandPos.x = handPos.x; lastHandPos.y = handPos.y; }
        if(currentState === STATE.SCATTER) {
             status.innerHTML = "👋 <span style='color:#00ffff'>拨动地球仪</span>";
        }
    }
}

function drawSkeleton(ctx, landmarks, w, h) {
    ctx.lineWidth = 3; ctx.strokeStyle = '#00ff88'; ctx.fillStyle = '#ff0044';
    const connections = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
    ctx.beginPath();
    connections.forEach(p => { ctx.moveTo(landmarks[p[0]].x * w, landmarks[p[0]].y * h); ctx.lineTo(landmarks[p[1]].x * w, landmarks[p[1]].y * h); });
    ctx.stroke();
}

function onWindowResize() {
    const width = window.innerWidth, height = window.innerHeight;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    updateCameraPosition();
    renderer.setSize(width, height);
    if(composer) composer.setSize(width, height);
    updatePixelRatio();
}

window.toggleFull = function() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
    else document.exitFullscreen().catch(()=>{});
};

const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('file-input');
uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', function(e) {
    const files = e.target.files;
    if (!files.length) return;
    let addCount = Math.min(files.length, MAX_PHOTOS - photoMeshes.length);
    if(photoMeshes.length >= MAX_PHOTOS) { alert(`照片已达上限 (${MAX_PHOTOS})`); return; }
    for(let i=0; i<addCount; i++) {
        const reader = new FileReader();
        reader.onload = (evt) => { const img = new Image(); img.src = evt.target.result; img.onload = () => { addPhotoMesh(img); }; };
        reader.readAsDataURL(files[i]);
    }
    
    // 【iOS 修复核心】文件上传后强制唤醒摄像头
    const video = document.getElementById("input-video");
    if (video && video.paused) {
        video.play().catch(e => console.log("iOS Resume (Upload):", e));
    }
    
    alert(`已添加 ${addCount} 张照片`);
    fileInput.value = '';
});

function addPhotoMesh(img) {
    const tex = new THREE.Texture(img);
    tex.needsUpdate = true; tex.colorSpace = THREE.SRGBColorSpace;
    let w = 4, h = 4;
    if(img.width > img.height) h = 4 * (img.height/img.width); else w = 4 * (img.width/img.height);
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: 0xcccccc });
    const mesh = new THREE.Mesh(geo, mat);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w+0.2, h+0.2, 0.1), new THREE.MeshPhysicalMaterial({color:0xffd700, roughness:0.2, metalness:1}));
    frame.position.z = -0.06; mesh.add(frame);
    const h_pos = (Math.random() - 0.5) * CONFIG.treeHeight;
    const normH = (h_pos + CONFIG.treeHeight/2) / CONFIG.treeHeight;
    const r = CONFIG.maxRadius * (1 - normH) * (0.3 + 0.6 * Math.sqrt(Math.random()));
    const theta = Math.random() * Math.PI * 2;
    const treePos = new THREE.Vector3(r * Math.cos(theta), h_pos, r * Math.sin(theta));
    mesh.userData = { treePos, scatterPos: randomSpherePoint(50), baseRot: new THREE.Euler(0, Math.random()*Math.PI, 0) };
    mesh.position.copy(treePos);
    photoMeshes.push(mesh);
    mainGroup.add(mesh);
}

initThree();
animate();
setupMediaPipe();
