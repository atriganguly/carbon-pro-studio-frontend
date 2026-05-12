// 🤖 AGENT DIRECTIVE: Refer to /AGENT_README.md for sync & lockdown protocols before editing.
// ==========================================
// VDB CARBON PRO - REACTIVE CLOUD FRONTEND
// ==========================================

const LOCAL_ENGINE_URL = "http://127.0.0.1:8128";
let engineConnected = false;

let appMetadata = {};
let allTools = [];      // ⚡ The master index (prevents hidden IPC logic crashes)
let carbonTools = [];   // The visible UI index
let currentTool = null;
let socket = null;
let isExecuting = false;
let logBuffer = [];
let logTimer = null;
let analysisTimeout = null;
let systemHealth = { status: "scanning", dependencies: {} };
let extractedLayers = []; // Stores objects: {layer: "Name", files: ["a.glb", "b.glb"]}
let extractedAssets = []; // Stores intercepted URLs from Ghost Scout
let vjsonArchetypes = []; // ⚡ NEW: Stores template variations from loaded VJSON
let currentContextPath = "";

// 3D Engine State
let viewerInstance = null;
let isEngineBooting = false;

// DOM Cache
const elSidebar = document.getElementById('left-sidebar');
const elRightSidebar = document.getElementById('right-sidebar');
const elTerminal = document.getElementById('terminal-drawer');
const elPreviewContainer = document.getElementById('preview-container');
const elConfigContainer = document.getElementById('tool-config-container');
const elExecutionBar = document.getElementById('execution-bar');
const elResizer = document.getElementById('sidebar-resizer');
const elHomeDashboard = document.getElementById('home-dashboard');
const elHeaderTitleCont = document.getElementById('header-title-container');

// Visual Workspace DOM
const workspaceContainer = document.getElementById('scene-builder-workspace');
const tweakpaneContainer = document.getElementById('tweakpane-container');
const inspectorTitle = document.getElementById('inspector-title');

// Engine Toggle DOM
const elHeaderToggle = document.getElementById('header-engine-toggle');
const btnModeVisual = document.getElementById('btn-mode-visual');
const btnModeBatch = document.getElementById('btn-mode-batch');

// ⚡ GLOBAL ICON FACTORY (Zero-Hardcoding Uniformity)
const IconFactory = {
    useFallback: false,
    getPhosphorClass(cdnIcon) {
        if (!cdnIcon) return '';
        const weightMatch = cdnIcon.match(/-(thin|light|regular|bold|fill|duotone)$/);
        if (weightMatch) {
            const weight = weightMatch[1];
            const baseName = cdnIcon.replace(`-${weight}`, '');
            return `ph-${weight} ${baseName}`;
        }
        return `ph ${cdnIcon}`;
    },
    getToolIcon(tool, size = '18px') {
        if (!this.useFallback && tool.cdn_icon) {
            return `<i class="${this.getPhosphorClass(tool.cdn_icon)} premium-tool-icon" style="font-size: ${size};"></i>`;
        }
        return `<svg width="${parseInt(size)}" height="${parseInt(size)}"><use href="#icon-${tool.icon || 'cube.fill'}"></use></svg>`;
    },
    getIcon(cdnClass, fallbackSvg, size = '16px') {
        if (!this.useFallback && cdnClass) {
            return `<i class="${this.getPhosphorClass(cdnClass)}" style="font-size: ${size}; line-height: 1; flex-shrink: 0;"></i>`;
        }
        return fallbackSvg;
    },
    syncStaticDOM(selector, cdnClass) {
        const el = document.querySelector(selector);
        if (!el) return;
        if (!this.useFallback) {
            const svg = el.querySelector('svg');
            if (svg) {
                const i = document.createElement('i');
                i.className = `${this.getPhosphorClass(cdnClass)}`;
                i.style.fontSize = svg.getAttribute('width') ? `${svg.getAttribute('width')}px` : '18px';
                svg.replaceWith(i);
            }
        }
    }
};

function parseToolName(rawName) {
    const match = rawName.match(/^(.*?)\s*\((.*?)\)$/);
    if (match) {
        return { brand: match[1].trim(), generic: match[2].trim() };
    }
    return { brand: rawName, generic: '' };
}

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let cdnClass = 'ph-info-duotone';
    let fallbackSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    
    if(type === 'success') {
        cdnClass = 'ph-check-circle-duotone';
        fallbackSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>';
    } else if(type === 'error') {
        cdnClass = 'ph-warning-circle-duotone';
        fallbackSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }

    toast.innerHTML = `${IconFactory.getIcon(cdnClass, fallbackSvg, '18px')} <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-20px) translateX(-50%)'; setTimeout(() => toast.remove(), 300); }, 3500);
}

function flushLogs() {
    const con = document.getElementById('console');
    if (con && logBuffer.length > 0) { con.insertAdjacentHTML('beforeend', logBuffer.join('')); con.scrollTop = con.scrollHeight; logBuffer = []; }
    logTimer = null;
}

function queueLog(html) {
    logBuffer.push(html);
    if (!logTimer) logTimer = requestAnimationFrame(flushLogs);
}

async function verifyCDN() {
    if (!navigator.onLine) {
        IconFactory.useFallback = true; return;
    }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        await fetch('https://unpkg.com/@phosphor-icons/web', { mode: 'no-cors', signal: controller.signal });
        clearTimeout(timeoutId);
        IconFactory.useFallback = false;
    } catch (error) {
        console.warn("[SYSTEM] CDN unreachable or offline. Falling back to native SVG icons.");
        IconFactory.useFallback = true;
    }
}

// ⚡ ENGINE HEARTBEAT: Ping local backend and update connection state
async function checkEngineConnection() {
    const dot = document.getElementById('engine-dot');
    const text = document.getElementById('engine-text');
    const widget = document.getElementById('engine-connection-widget')?.querySelector('.health-indicator');
    
    // Diagnostic elements
    const diagDot = document.getElementById('health-dot');
    const diagText = document.getElementById('health-text');
    const diagList = document.getElementById('health-dropdown-list');

    try {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/health`, { method: 'GET', mode: 'cors' });
        
        if (res.ok) {
            if (!engineConnected) {
                engineConnected = true;
                if(dot) dot.className = "health-dot green";
                if(text) { text.innerText = "Local Engine Active"; text.style.color = "var(--success)"; }
                if(widget) { widget.style.background = "rgba(50, 215, 75, 0.1)"; widget.style.borderColor = "rgba(50, 215, 75, 0.3)"; }
                
                showToast("Local VDB Core detected and connected.", "success");
                
                // Fetch tool manifests if not yet loaded
                if(allTools.length === 0) fetchTools();

                // ⚡ FIX: Auto-unlock UI if a tool is open, ONLY on the transition to Online
                if(currentTool && !isExecuting) renderTool(currentTool);
            }
            
            // Sync Diagnostics
            systemHealth = await res.json();
            if(diagDot) diagDot.className = `health-dot ${systemHealth.status}`;
            if(diagText) diagText.innerText = systemHealth.status === 'green' ? 'Core Nominal' : 'System Alert';

            if(diagList) {
                diagList.innerHTML = Object.entries(systemHealth.dependencies).map(([key, data]) => `
                    <div class="health-item"><div class="health-item-top"><span class="health-name">${key.charAt(0).toUpperCase() + key.slice(1)}</span><span class="health-status-label status-${data.status}">${data.status}</span></div><div class="health-path">${data.version} • ${data.type}</div></div>
                `).join('');
            }
        }
    } catch (e) {
        if (engineConnected || (engineConnected === false && text && text.innerText !== "Engine Offline")) {
            engineConnected = false;
            if(dot) dot.className = "health-dot red";
            if(text) { text.innerText = "Engine Offline"; text.style.color = "var(--danger)"; }
            if(widget) { widget.style.background = "rgba(255, 69, 58, 0.1)"; widget.style.borderColor = "rgba(255, 69, 58, 0.3)"; }
            
            // Sync Diagnostics for Offline Mode
            if(diagDot) diagDot.className = `health-dot red`;
            if(diagText) diagText.innerText = 'System Offline';
            if(diagList) diagList.innerHTML = `<div class="health-item"><div class="health-item-top"><span class="health-name">Engine Connection</span><span class="health-status-label status-missing">MISSING</span></div><div class="health-path">Awaiting Localhost Bridge...</div></div>`;
            
            showToast("Connection to local engine lost.", "error");
            
            // ⚡ FIX: Auto-lock UI if a tool is open, ONLY on transition to Offline
            if(currentTool && !isExecuting) renderTool(currentTool);
        }
    }
}

async function fetchTools() {
    try {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/tools`);
        allTools = await res.json();
        carbonTools = allTools.filter(t => !t.is_hidden);
        
        const list = document.getElementById('tool-list');
        list.innerHTML = carbonTools.map(t => {
            const names = parseToolName(t.name);
            const labelHtml = names.generic ? `<span class="tool-generic-label">${names.generic}</span>` : '';
            const devLabel = t.is_dev ? `<span class="status-label dev-label">DEV</span>` : '';
            const betaLabel = t.is_beta ? `<span class="status-label beta-label">BETA</span>` : '';

            return `
            <div class="nav-item" id="nav-${t.id}" data-id="${t.id}" title="${t.name}">
                ${IconFactory.getToolIcon(t, '18px')}
                <div class="tool-name-container">
                    <span class="tool-name">${names.brand} ${devLabel}${betaLabel}</span>
                    ${labelHtml}
                </div>
            </div>
            `;
        }).join('');

        document.querySelectorAll('.nav-item').forEach(el => {
            if (el.id === 'nav-home' || el.id === 'nav-agent-docs') return;
            el.addEventListener('click', () => { const tool = carbonTools.find(x => x.id === el.dataset.id); if(tool) renderTool(tool); });
        });
        
        if (!currentTool) buildGamifiedBlueprint();
        if (!currentTool) buildToolGrid();
    } catch (e) { console.warn("Waiting for engine to provide tools."); }
}

async function init() {
    await verifyCDN(); 
    
    try {
        const res = await fetch('./app.manifest.json');
        appMetadata = await res.json();
        applyGlobalIdentity();
    } catch(e) { console.error("Manifest failed to load", e); }

    document.getElementById('toggle-left-sidebar').addEventListener('click', () => elSidebar.classList.toggle('collapsed'));
    document.getElementById('nav-home').addEventListener('click', renderHome);
    
    const btnAgentDocs = document.getElementById('nav-agent-docs');
    if(btnAgentDocs) btnAgentDocs.addEventListener('click', renderAgentDocs);
    
    document.getElementById('theme-btn').addEventListener('click', () => {
        const r = document.documentElement;
        const next = r.getAttribute('data-theme') === 'carbon-black' ? 'white-diamond' : 'carbon-black';
        r.setAttribute('data-theme', next);
        updateLogoForTheme(next);
    });

    document.getElementById('toggle-right-sidebar').addEventListener('click', (e) => { elRightSidebar.classList.toggle('collapsed'); e.currentTarget.classList.toggle('is-active'); });
    document.getElementById('toggle-terminal').addEventListener('click', (e) => { if(e.target.closest('#close-terminal')) return; elTerminal.classList.toggle('collapsed'); });
    document.getElementById('close-terminal').addEventListener('click', () => elTerminal.classList.add('collapsed'));
    document.getElementById('close-right-sidebar').addEventListener('click', () => { elRightSidebar.classList.add('collapsed'); document.getElementById('toggle-right-sidebar').classList.remove('is-active'); });
    document.getElementById('exec-btn').addEventListener('click', runTool);

    if(btnModeVisual) btnModeVisual.addEventListener('click', () => { if(!isExecuting) setWorkspaceMode('visual'); });
    if(btnModeBatch) btnModeBatch.addEventListener('click', () => { if(!isExecuting) setWorkspaceMode('batch'); });

    document.getElementById('sb-load-model').addEventListener('click', () => triggerVisualFileMount('.glb,.gltf,.obj,.fbx'));
    document.getElementById('sb-load-vjson').addEventListener('click', () => triggerVisualFileMount('.vjson'));
    document.getElementById('sb-export-vjson').addEventListener('click', triggerVisualExport);

    initResizer();
    
    // Sync static layout buttons with Factory
    IconFactory.syncStaticDOM('#toggle-left-sidebar', 'ph-list-duotone');
    IconFactory.syncStaticDOM('#nav-home', 'ph-house-duotone');
    IconFactory.syncStaticDOM('#nav-agent-docs', 'ph-file-code-duotone');
    IconFactory.syncStaticDOM('#toggle-right-sidebar', 'ph-sidebar-simple-duotone');
    IconFactory.syncStaticDOM('#theme-btn', 'ph-palette-duotone');

    // Start Engine Heartbeat
    setInterval(checkEngineConnection, 3000);
    checkEngineConnection();
    
    renderHome();
}

window.triggerToolViaId = (toolId) => {
    const tool = carbonTools.find(x => x.id === toolId) || allTools.find(x => x.id === toolId);
    if(tool) renderTool(tool);
};

function applyGlobalIdentity() {
    document.getElementById('dom-page-title').innerText = `${appMetadata.app_name} | ${appMetadata.tagline}`;
    document.getElementById('dom-nav-title').innerText = appMetadata.app_name;
    document.getElementById('dom-hero-title').innerText = appMetadata.app_name;
    document.getElementById('dom-hero-tagline').innerText = appMetadata.tagline;
    document.getElementById('dom-sidebar-version').innerText = `v${appMetadata.version} • ${appMetadata.creator}`;
    document.getElementById('dom-term-boot').innerText = `> ${appMetadata.app_name} Engine v${appMetadata.version} Initialized.`;
    
    updateLogoForTheme(document.documentElement.getAttribute('data-theme'));
    buildRoadmapMatrix();
}

function updateLogoForTheme(theme) {
    if(!appMetadata.logo_light) return;
    const logoSrc = theme === 'carbon-black' ? appMetadata.logo_dark : appMetadata.logo_light;
    
    document.getElementById('dom-nav-logo').src = logoSrc;
    document.getElementById('dom-hero-logo').src = logoSrc;
    document.getElementById('dom-favicon').href = logoSrc;
}

function buildGamifiedBlueprint() {
    const container = document.getElementById('blueprint-container');
    if(!carbonTools.length) {
        container.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Waiting for Engine Connection...</span>';
        return;
    }
    let html = `<div class="bp-track">`;
    carbonTools.forEach((tool, index) => {
        const names = parseToolName(tool.name);
        html += `
        <div class="bp-node" style="border-left-color: ${tool.color || 'var(--tool-accent)'}" title="Launch ${tool.name}" onclick="window.triggerToolViaId('${tool.id}')">
            <div class="bp-icon" style="color:${tool.color}">${IconFactory.getToolIcon(tool, '16px')}</div>
            <div class="bp-info">
                <div class="bp-name">${names.brand}</div>
                <div class="bp-engine">${tool.engine} core</div>
            </div>
        </div>`;
        if (index < carbonTools.length - 1) html += `<div class="bp-line"></div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
}

function buildToolGrid() {
    const container = document.getElementById('home-tools-grid');
    if(!carbonTools.length) {
        container.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Waiting for Engine Connection...</span>';
        return;
    }
    container.innerHTML = carbonTools.map(t => {
        const names = parseToolName(t.name);
        const labelHtml = names.generic ? `<div class="tool-grid-generic">${names.generic}</div>` : '';
        const devLabel = t.is_dev ? `<span class="status-label dev-label">DEV</span>` : '';
        const betaLabel = t.is_beta ? `<span class="status-label beta-label">BETA</span>` : '';
        return `
        <div class="tool-grid-card" onclick="window.triggerToolViaId('${t.id}')">
            <div class="tool-grid-icon" style="color:${t.color || 'var(--tool-accent)'};">${IconFactory.getToolIcon(t, '24px')}</div>
            <div>
                <div class="tool-grid-name">${names.brand} ${devLabel}${betaLabel}</div>
                ${labelHtml}
            </div>
        </div>
        `;
    }).join('');
}

async function fetchArchitecture() {
    const container = document.getElementById('architecture-console-container');
    if (!engineConnected) {
        container.innerHTML = `<div class="empty-preview"><span>Engine offline. Scanner suspended.</span></div>`;
        return;
    }
    try {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/architecture`);
        const data = await res.json();
        let html = `<table class="arch-table"><thead><tr><th>Module</th><th>Function Signature</th><th>Status</th></tr></thead><tbody>`;
        for (const [moduleName, funcs] of Object.entries(data)) {
            funcs.forEach(f => {
                html += `<tr><td class="func-module">${moduleName}</td><td><div class="func-name">${f.name}()</div><div style="font-size:10px; color:var(--text-secondary); margin-top:4px;">${f.doc}</div></td><td class="func-status">Synchronized</td></tr>`;
            });
        }
        html += `</tbody></table>`;
        container.innerHTML = html;
        container.style.padding = '0'; 
    } catch(e) { 
        container.innerHTML = `<div class="empty-preview"><span>Scanner offline or inaccessible.</span></div>`; 
    }
}

function buildRoadmapMatrix() {
    const container = document.getElementById('roadmap-container');
    if(!appMetadata.roadmap || !appMetadata.roadmap.length) { container.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">No roadmap configured.</span>'; return; }
    container.innerHTML = appMetadata.roadmap.map(item => `
        <div class="rm-item ${item.status}">
            <div class="rm-status-dot"></div>
            <div class="rm-details">
                <div class="rm-title">${item.title}</div>
                <div class="rm-phase">${item.phase}</div>
            </div>
        </div>
    `).join('');
}

async function renderAgentDocs() {
    if (isExecuting) { showToast('Execution in progress. Please halt first.', 'warning'); return; }

    renderHome();
    document.getElementById('nav-home').classList.remove('active');
    document.getElementById('nav-agent-docs').classList.add('active');
    
    document.getElementById('dom-hero-title').innerText = "Agent Protocol";
    document.getElementById('dom-hero-tagline').innerText = "System Directives & Autonomous Flows";
    
    const consoleContainer = document.getElementById('architecture-console-container');
    
    if (!engineConnected) {
        consoleContainer.innerHTML = `<div class="empty-preview"><span>Engine Offline. Markdown rendering blocked.</span></div>`;
        return;
    }
    
    consoleContainer.innerHTML = `<div class="empty-preview"><img src="./assets/carbon-logo.png" class="carbon-spinner" style="display:block;"><span>Decrypting Agent Protocols...</span></div>`;
    consoleContainer.style.padding = '30px'; 
    
    try {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/agent-readme`);
        const data = await res.json();
        consoleContainer.innerHTML = data.html;
    } catch(e) { 
        consoleContainer.innerHTML = "<p>Agent Documentation offline or missing.</p>"; 
    }
}

function renderHome() {
    currentTool = null;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-home').classList.add('active');
    
    elHomeDashboard.style.display = 'flex';
    elConfigContainer.style.display = 'none';
    elExecutionBar.style.display = 'none';
    elHeaderTitleCont.style.display = 'none';
    
    workspaceContainer.style.display = 'none';
    tweakpaneContainer.style.display = 'none';
    elPreviewContainer.style.display = 'block';
    inspectorTitle.innerText = "Realtime Inspector";
    
    elRightSidebar.classList.add('collapsed');
    document.getElementById('toggle-right-sidebar').classList.remove('is-active');
    
    document.getElementById('dom-hero-title').innerText = appMetadata.app_name || "VDB Carbon";
    document.getElementById('dom-hero-tagline').innerText = appMetadata.tagline || "Initializing...";
    
    buildGamifiedBlueprint();
    buildToolGrid();
    fetchArchitecture();
}

function setWorkspaceMode(mode) {
    if (mode === 'visual') {
        elConfigContainer.style.display = 'none';
        elExecutionBar.style.display = 'none';
        elPreviewContainer.style.display = 'none';

        workspaceContainer.style.display = 'block';
        tweakpaneContainer.style.display = 'block';
        inspectorTitle.innerText = "Scene Architecture";

        elRightSidebar.classList.remove('collapsed');
        document.getElementById('toggle-right-sidebar').classList.add('is-active');

        bootVisualEngine();

        if (btnModeVisual) btnModeVisual.classList.add('active');
        if (btnModeBatch) btnModeBatch.classList.remove('active');
    } else {
        workspaceContainer.style.display = 'none';
        tweakpaneContainer.style.display = 'none';

        elConfigContainer.style.display = 'flex';
        elExecutionBar.style.display = 'flex';
        elPreviewContainer.style.display = 'block';
        inspectorTitle.innerText = "Realtime Inspector";

        if (btnModeBatch) btnModeBatch.classList.add('active');
        if (btnModeVisual) btnModeVisual.classList.remove('active');
    }
}

function renderTool(tool) {
    if (isExecuting) { showToast('Execution in progress. Please halt first.', 'warning'); return; }
    
    currentTool = tool;
    elHomeDashboard.style.display = 'none';
    elHeaderTitleCont.style.display = 'inline-flex';

    const isVisual = (tool.ui_type || '').toLowerCase() === 'visual';
    const isHybrid = (tool.ui_type || '').toLowerCase() === 'hybrid';

    if (isHybrid) {
        elHeaderToggle.style.display = 'flex';
        setWorkspaceMode('visual'); 
    } else {
        elHeaderToggle.style.display = 'none';
        setWorkspaceMode(isVisual ? 'visual' : 'batch');
    }
    
    const accent = tool.color || 'var(--tool-accent)';
    document.documentElement.style.setProperty('--tool-accent', accent);
    
    const names = parseToolName(tool.name);
    const devLabel = tool.is_dev ? `<span class="status-label dev-label">DEV</span>` : '';
    const betaLabel = tool.is_beta ? `<span class="status-label beta-label">BETA</span>` : '';
    
    document.getElementById('header-title').innerHTML = `${names.brand} ${devLabel}${betaLabel} <span style="opacity: 0.6; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-left: 8px; border-left: 1px solid var(--border-subtle); padding-left: 8px;">${names.generic || 'Engine'}</span>`;

    let oldIcon = document.getElementById('header-tool-icon');
    let newIconWrapper = document.createElement('span');
    newIconWrapper.id = 'header-tool-icon';
    newIconWrapper.style.marginRight = "6px";
    newIconWrapper.innerHTML = IconFactory.getToolIcon(tool, '16px');
    oldIcon.replaceWith(newIconWrapper);

    document.getElementById('tool-description').innerText = tool.description;
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    const navItem = document.getElementById(`nav-${tool.id}`);
    if (navItem) navItem.classList.add('active');

    const execBtn = document.getElementById('exec-btn');
    const btnText = document.getElementById('btn-text');
    let toolDis = false;
    let toolDisReason = "";

    // ⚡ UI LOCKDOWN: Block execution if backend is not connected
    if (!engineConnected) {
        toolDis = true;
        toolDisReason = "The Carbon Pro Engine is not running on your computer. Please launch it.";
    } else {
        let validationEngine = tool.engine === 'hybrid' ? 'python' : tool.engine;
        
        if (validationEngine && systemHealth.dependencies[validationEngine] && systemHealth.dependencies[validationEngine].status !== 'ok') {
            toolDis = true;
            toolDisReason = `${validationEngine.toUpperCase()} Core Engine is unavailable or misconfigured.`;
        }

        // ⚡ ZERO HARDCODING: Dynamic validation of tool dependencies from manifest
        if (!toolDis && tool.dependencies && Array.isArray(tool.dependencies)) {
            for (let d of tool.dependencies) {
                if (systemHealth.dependencies[d] && systemHealth.dependencies[d].status !== 'ok') {
                    toolDis = true; 
                    toolDisReason = `Required Dependency '${d}' is offline. Check Diagnostics.`; 
                    break;
                }
            }
        }
    }

    if (toolDis) {
        execBtn.disabled = true; execBtn.classList.add('disabled-ui');
        execBtn.title = toolDisReason; 
        btnText.innerText = !engineConnected ? "Launch Desktop App" : "Engine Offline";
    } else {
        execBtn.disabled = false; execBtn.classList.remove('disabled-ui');
        execBtn.removeAttribute('title'); btnText.innerText = "Execute Protocol";
    }
    
    const groups = {};
    if(tool.inputs) {
        tool.inputs.forEach(i => { const gn = i.group || 'General Settings'; if (!groups[gn]) groups[gn] = []; groups[gn].push(i); });
    }

    let gridHtml = '';
    const fileIcon = IconFactory.getIcon('ph-file-duotone', '<svg width="16" height="16"><use href="#icon-file"></use></svg>', '16px');
    const folderIcon = IconFactory.getIcon('ph-folder-duotone', '<svg width="16" height="16"><use href="#icon-folder"></use></svg>', '16px');

    for (const [groupName, inputs] of Object.entries(groups)) {
        const inputsHtml = inputs.map(i => {
            if (i.type === 'hidden') return `<input type="hidden" id="input-${i.id}" value="${i.default}">`;
            
            const infoCol = `<div class="form-info"><div class="form-label">${i.label}</div><div class="form-hint">${i.hint || ''}</div></div>`;
            let ctrl = '';

            if (i.type === 'checkbox') {
                const checked = i.default === 'true' || i.default === true ? 'checked' : '';
                ctrl = `<label class="toggle-switch"><input type="checkbox" id="input-${i.id}" ${checked} class="app-input"><span class="slider"></span></label>`;
                return `<div class="form-row" style="flex-direction:row; align-items:center; justify-content:space-between;">${infoCol}<div class="form-control" style="width:auto; min-width:auto;">${ctrl}</div></div>`;
            } else if (i.type === 'select' && i.options) {
                if (i.options.length <= 4) {
                    const segments = i.options.map(opt => {
                        let activeCls = (opt.value === i.default) ? 'active' : '';
                        let disabledAttr = '';
                        
                        // ⚡ DYNAMIC UI LOCKDOWN: Grey out Rhino if missing from OS
                        if (opt.value === 'rhino' && (!systemHealth.dependencies['rhino'] || systemHealth.dependencies['rhino'].status !== 'ok')) {
                            disabledAttr = 'disabled title="Rhino 8 Core not detected on this OS"';
                            activeCls = ''; // Prevent it from being visually active if disabled
                        }
                        
                        return `<button type="button" class="segment-btn ${activeCls}" data-target="input-${i.id}" data-val="${opt.value}" ${disabledAttr}>${opt.label.split('(')[0].trim()}</button>`;
                    }).join('');
                    ctrl = `<input type="hidden" id="input-${i.id}" value="${i.default}" class="app-input"><div class="segmented-control">${segments}</div>`;
                } else {
                    const opts = i.options.map(opt => {
                        let disabledAttr = '';
                        
                        // ⚡ DYNAMIC UI LOCKDOWN: Grey out Rhino if missing from OS
                        if (opt.value === 'rhino' && (!systemHealth.dependencies['rhino'] || systemHealth.dependencies['rhino'].status !== 'ok')) {
                            disabledAttr = 'disabled title="Rhino 8 Core not detected on this OS"';
                        }
                        
                        return `<option value="${opt.value}" ${opt.value === i.default ? 'selected' : ''} ${disabledAttr}>${opt.label}</option>`;
                    }).join('');
                    ctrl = `<select id="input-${i.id}" class="liquid-input app-input">${opts}</select>`;
                }
            } else if (['file', 'file_or_folder', 'folder'].includes(i.type)) {
                // Ensure UI is greyed out if no connection
                const btnLock = !engineConnected ? 'disabled' : '';
                ctrl = `<input type="hidden" id="input-${i.id}" value="${i.default}" class="app-input"><div class="path-picker-group"><div class="path-display" id="display-${i.id}">${i.default || 'No source selected...'}</div><div class="path-btn-group"><button type="button" class="path-btn" data-target="${i.id}" data-type="file" title="Select File" ${btnLock}>${fileIcon}</button><button type="button" class="path-btn" data-target="${i.id}" data-type="folder" title="Select Folder" ${btnLock}>${folderIcon}</button></div></div>`;
            } else { 
                const typeAttr = i.type === 'range' ? 'range' : (i.type === 'password' ? 'password' : 'text');
                const extraAttrs = i.type === 'range' ? `min="${i.min}" max="${i.max}" step="${i.step}"` : '';
                const displayVal = i.type === 'range' ? `<span style="font-size:10px; opacity:0.5; margin-left:10px;" id="val-${i.id}">${i.default}</span>` : '';
                
                ctrl = `<input type="${typeAttr}" class="${i.type === 'range' ? 'slider-input' : 'liquid-input'} app-input" id="input-${i.id}" value="${i.default}" placeholder="..." ${extraAttrs}>${displayVal}`; 
            }
            
            return `<div class="form-row">${infoCol}<div class="form-control">${ctrl}</div></div>`;
        }).join('');
        gridHtml += `<div class="config-card"><div class="card-title">${groupName}</div>${inputsHtml}</div>`;
    }

    elConfigContainer.querySelector('#dynamic-grid').innerHTML = gridHtml;
    
    setupDynamicModelDropdown();

    const existingRes = document.getElementById('vdb-extractor-results');
    if (existingRes) existingRes.remove();
    const existingAssetSel = document.getElementById('vdb-asset-selector-results');
    if (existingAssetSel) existingAssetSel.remove();
    
    bindDynamicEvents();
    triggerRealtimeAnalysis();
}

function setupDynamicModelDropdown() {
    const apiKeyInput = document.getElementById('input-api_key');
    const modelNameInput = document.getElementById('input-model_name');

    if (apiKeyInput && modelNameInput) {
        let selectEl = modelNameInput;
        if (modelNameInput.tagName !== 'SELECT') {
            selectEl = document.createElement('select');
            selectEl.id = modelNameInput.id;
            selectEl.className = "liquid-input app-input";
            selectEl.innerHTML = `<option value="">Awaiting API Key...</option>`;
            modelNameInput.replaceWith(selectEl);
        }
        
        let debounceTimer;
        const fetchModels = async (key) => {
            if (!engineConnected) return; // Don't try if engine is offline
            try {
                selectEl.innerHTML = `<option value="">Detecting Vision Models...</option>`;
                const res = await fetch(`${LOCAL_ENGINE_URL}/api/llm/models`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({api_key: key})
                });
                const data = await res.json();
                if(data.models) {
                    selectEl.innerHTML = data.models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
                    triggerRealtimeAnalysis(); 
                }
            } catch(err) {
                console.error("LLM Heuristic Scan Failed", err);
            }
        };

        apiKeyInput.addEventListener('keyup', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => fetchModels(e.target.value.trim()), 600);
        });
        
        if(apiKeyInput.value) fetchModels(apiKeyInput.value.trim());
    }
}

async function bootVisualEngine() {
    if (viewerInstance) {
        viewerInstance.resize();
        return; 
    }

    if (isEngineBooting) return;
    isEngineBooting = true;

    showToast("Downloading GPU Accelerated Engine...", "info");

    try {
        const threepipe = await import('threepipe');
        const webgiPlugins = await import('@threepipe/webgi-plugins');
        
        const ThreeViewer = threepipe.ThreeViewer;
        const AssetExporterPlugin = threepipe.AssetExporterPlugin;
        const TweakpaneUiPlugin = webgiPlugins.TweakpaneUiPlugin;
        
        const canvas = document.getElementById('threepipe-canvas');
        
        viewerInstance = new ThreeViewer({
            canvas: canvas,
            msaa: true,
            rgbm: true,
            dropzone: true,
        });

        const uiPlugin = viewerInstance.addPluginSync(new TweakpaneUiPlugin(true));
        viewerInstance.addPluginSync(new AssetExporterPlugin());

        uiPlugin.setupPluginUi(tweakpaneContainer);

        window.addEventListener('resize', () => {
            if (workspaceContainer.style.display === 'block') viewerInstance.resize();
        });

        showToast("Threepipe Engine Active", "success");
    } catch (error) {
        console.error("[CARBON ERROR] 3D Engine Fault:", error);
        showToast("Failed to boot 3D Engine. Ensure you have internet access.", "error");
    } finally {
        isEngineBooting = false;
    }
}

function triggerVisualFileMount(acceptString) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptString;
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        showToast(`Mounting ${file.name}...`, "info");
        try {
            await viewerInstance.load(file);
            showToast("Asset successfully mounted.", "success");
        } catch (err) {
            console.error("Asset Load Fault:", err);
            showToast("Failed to parse asset schema.", "error");
        }
    };
    input.click();
}

async function triggerVisualExport() {
    if (!viewerInstance) return;
    showToast("Compiling Scene Configuration...", "info");
    
    try {
        const config = viewerInstance.toJSON();
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Carbon_Optimized_Scene.vjson';
        a.click();
        URL.revokeObjectURL(url);
        
        showToast("VJSON Exported Successfully.", "success");
    } catch (e) {
        console.error("Export Fault:", e);
        showToast("Failed to compile VJSON.", "error");
    }
}

function bindDynamicEvents() {
    document.querySelectorAll('.segment-btn').forEach(btn => { 
        btn.addEventListener('click', (e) => { 
            if (e.target.disabled) return; 
            const val = e.target.dataset.val; 
            const targetId = e.target.dataset.target;
            if (targetId) {
                document.getElementById(targetId).value = val; 
            }
            e.target.parentNode.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active')); 
            e.target.classList.add('active'); 
            triggerRealtimeAnalysis(); 
        }); 
    });
    document.querySelectorAll('.path-btn').forEach(btn => { 
        btn.addEventListener('click', async (e) => { 
            if (isExecuting || !engineConnected) return; 
            const b = e.target.closest('.path-btn'); 
            const res = await fetch(`${LOCAL_ENGINE_URL}/api/browse?type=${b.dataset.type}`); 
            const data = await res.json(); 
            if (data.path) { 
                document.getElementById(`input-${b.dataset.target}`).value = data.path; 
                const display = document.getElementById(`display-${b.dataset.target}`); 
                display.innerText = data.path; 
                display.classList.add('has-value'); 
                triggerRealtimeAnalysis(); 
            } 
        }); 
    });
    document.querySelectorAll('.app-input').forEach(input => { 
        const eventType = input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'range' ? 'change' : 'keyup'; 
        
        if(input.type === 'range') {
            input.addEventListener('input', (e) => {
                const label = document.getElementById(`val-${e.target.id.replace('input-', '')}`);
                if(label) label.innerText = e.target.value;
            });
        }
        input.addEventListener(eventType, triggerRealtimeAnalysis); 
    });
}

function triggerRealtimeAnalysis() {
    if (!currentTool || isExecuting || !engineConnected) return;
    if (currentTool.ui_type === 'visual') return;
    if (currentTool.ui_type === 'hybrid' && btnModeVisual && btnModeVisual.classList.contains('active')) return;
    
    clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(async () => {
        const params = {}; let hasData = false;
        if(currentTool && currentTool.inputs) {
            currentTool.inputs.forEach(i => { 
                const el = document.getElementById(`input-${i.id}`); 
                if(el) { 
                    params[i.id] = i.type === 'checkbox' ? el.checked : el.value; 
                    if(['file', 'file_or_folder', 'folder', 'text'].includes(i.type) && params[i.id] !== "") hasData = true; 
                } 
            });
        }
        
        const emptyIcon = IconFactory.getIcon('ph-magnifying-glass-duotone', '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>', '24px');
        
        if(!hasData) { 
            elPreviewContainer.innerHTML = `<div class="empty-preview">${emptyIcon}<span>Select assets to begin...</span></div>`; 
            return; 
        }

        elPreviewContainer.innerHTML = `<div class="empty-preview"><img src="./assets/carbon-logo.png" class="carbon-spinner" style="display:block;"><span>Interpreting metadata...</span></div>`;
        try {
            const res = await fetch(`${LOCAL_ENGINE_URL}/api/analyze/${currentTool.id}`, { method: 'POST', body: JSON.stringify(params) });
            const data = await res.json(); 
            if(data.error) throw new Error(data.error);
            const analysis = data._vdb_analysis; let html = '<div class="analysis-dashboard">';
            if (analysis.summary) { 
                html += `<div class="summary-grid">`; 
                for (const [k, v] of Object.entries(analysis.summary)) { 
                    html += `<div class="summary-card"><div class="summary-val">${v}</div><div class="summary-label">${k}</div></div>`; 
                } 
                html += `</div>`; 
            }
            if (analysis.preview_items) { 
                html += `<div class="preview-list-header">Engine Targets</div>`; 
                analysis.preview_items.forEach(item => { 
                    html += `<div class="preview-item"><div class="preview-item-top"><span class="preview-filename">${item.File}</span><span class="preview-size">${item.Size}</span></div>${item.Data ? `<div class="preview-details">${item.Data}</div>` : ''}</div>`; 
                }); 
            }
            elPreviewContainer.innerHTML = html + '</div>';
        } catch (e) { 
            elPreviewContainer.innerHTML = `<div class="empty-preview"><span>Telemetry Blocked: ${e.message}</span></div>`; 
        }
    }, 250);
}

async function runTool() {
    if (isExecuting || !engineConnected) return;
    if (currentTool && (currentTool.ui_type || '').toLowerCase() === 'visual') return;
    if (currentTool && (currentTool.ui_type || '').toLowerCase() === 'hybrid' && btnModeVisual && btnModeVisual.classList.contains('active')) return;

    isExecuting = true;
    extractedLayers = [];
    extractedAssets = []; 
    vjsonArchetypes = []; // ⚡ Clear previous archetypes
    currentContextPath = "";
    
    const btn = document.getElementById('exec-btn'); btn.className = "btn-primary btn-danger"; document.getElementById('btn-spinner').style.display = 'block'; document.getElementById('btn-text').innerText = "Halt Protocol"; document.getElementById('status-dot').className = 'status-indicator running'; document.getElementById('status-text').innerText = 'Protocol Active';
    document.getElementById('terminal-drawer').classList.remove('collapsed');
    setTimeout(() => { document.querySelector('.workspace-scroll-area').scrollBy({ top: 300, behavior: 'smooth' }); }, 300);
    document.getElementById('console').innerHTML = `<div style="color:var(--tool-accent)">> ${appMetadata.app_name} Engine Initialized...</div>`; logBuffer = [];
    
    const existingRes = document.getElementById('vdb-extractor-results');
    if (existingRes) existingRes.remove();
    
    const existingAssetSel = document.getElementById('vdb-asset-selector-results');
    if (existingAssetSel) existingAssetSel.remove();

    const params = {}; 
    if(currentTool && currentTool.inputs) {
        currentTool.inputs.forEach(i => { const el = document.getElementById(`input-${i.id}`); if(el) params[i.id] = i.type === 'checkbox' ? el.checked : el.value; });
    }
    
    // ⚡ ZERO HARDCODING: Inject context meta to prevent script-side hardcoding
    params['_pipeline_metadata'] = {
        post_processor: currentTool.post_processor || null,
        action_target: currentTool.action_target_tool || null
    };

    try {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/run/${currentTool.id}`, { method: 'POST', body: JSON.stringify(params) });
        if (!res.ok) { const data = await res.json().catch(() => ({})); showToast(data.error || 'Engine initialization fault.', 'error'); resetExecutionState(); } else { showToast('System process initiated.', 'success'); }
    } catch(e) { showToast('Network fault executing engine.', 'error'); resetExecutionState(); }
}

function resetExecutionState() {
    isExecuting = false; const btn = document.getElementById('exec-btn');
    if (btn) { btn.className = "btn-primary"; document.getElementById('btn-text').innerText = "Execute Protocol"; document.getElementById('btn-spinner').style.display = 'none'; document.getElementById('status-dot').className = 'status-indicator ready'; document.getElementById('status-text').innerText = 'System Standby'; }
}

function connectSocket() {
    // Connect explicitly to the local engine websocket
    socket = new WebSocket(`ws://127.0.0.1:8128/ws/logs`);
    socket.onmessage = (e) => { 
        const line = e.data;
        
        if (line.includes('[UI_CONTEXT_PATH]')) {
            currentContextPath = line.substring(line.indexOf('[UI_CONTEXT_PATH]') + 17).trim();
            return; 
        }

        // ⚡ PHASE 1 INTEGRATION: Capture VJSON Archetypes for the UI
        if (line.includes('[UI_VJSON_VAR]')) {
            vjsonArchetypes.push(line.substring(line.indexOf('[UI_VJSON_VAR]') + 14).trim());
            return;
        }
        
        // ⚡ UPGRADED: Safely parse JSON payloads for layer extraction
        if (line.includes('[UI_EDIT_ROW]')) {
            try {
                const payloadStr = line.substring(line.indexOf('[UI_EDIT_ROW]') + 13).trim();
                const payload = JSON.parse(payloadStr);
                extractedLayers.push(payload);
            } catch (err) {
                // Fallback for older flat strings
                extractedLayers.push({layer: line.substring(line.indexOf('[UI_EDIT_ROW]') + 13).trim(), files: []});
            }
            return; 
        }
        
        // Capture the Ghost Scout interactive UI payload
        if (line.includes('[UI_SELECT_ROW]')) {
            extractedAssets.push(line.substring(line.indexOf('[UI_SELECT_ROW]') + 15).trim());
            return;
        }

        if (line.includes('[CARBON] FINISHED')) { 
            resetExecutionState(); 
            showToast('Batch execution complete.', 'success'); 
            
            // ⚡ ZERO HARDCODING: Trigger UI events based on abstract manifest flags
            if (currentTool && currentTool.on_complete_action === 'render_taxonomy_ui' && extractedLayers.length > 0) {
                renderExtractorResults();
            }
            if (currentTool && currentTool.on_complete_action === 'render_asset_selector' && extractedAssets.length > 0) {
                renderAssetSelector();
            }
        } else if (line.includes('[ERROR]')) {
            const errMsg = line.substring(line.indexOf('[ERROR]') + 7).trim();
            showToast(errMsg, 'error');
        }
        queueLog(`<div>> ${line}</div>`); 
    };
    socket.onclose = () => setTimeout(connectSocket, 2000);
}

// ⚡ The Dynamic UI rendering function for the Ghost Scout payload
function renderAssetSelector() {
    const existing = document.getElementById('vdb-asset-selector-results');
    if (existing) existing.remove();
    
    const linkIcon = IconFactory.getIcon('ph-link-duotone', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>', '16px');

    let rows = extractedAssets.map((asset, i) => `
        <div class="layer-mapping-row" style="cursor:pointer;" onclick="document.getElementById('asset-${i}').click()">
            <input type="checkbox" class="app-input asset-checkbox" id="asset-${i}" value="${asset}" checked style="width:16px;height:16px; margin:0;" onclick="event.stopPropagation()">
            <span style="color:var(--text-secondary); opacity:0.5; margin-left:10px;">${linkIcon}</span>
            <div class="layer-name-tag" style="flex:1;">${asset}</div>
        </div>
    `).join('');

    const downloadIcon = IconFactory.getIcon('ph-download-simple-duotone', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>', '18px');

    const html = `
    <div id="vdb-asset-selector-results" class="results-card" style="margin-top:20px;">
        <div class="results-header">
            <div class="results-title">
                ${downloadIcon}
                Intercepted Network Assets (${extractedAssets.length})
            </div>
        </div>
        <div class="results-body">
            ${rows}
        </div>
        <div class="results-footer" style="gap:10px;">
            <button class="btn-secondary" onclick="document.querySelectorAll('.asset-checkbox').forEach(cb => cb.checked = !cb.checked)">Toggle All</button>
            <button class="btn-primary" id="btn-download-assets" style="height:38px;">Download Selected...</button>
        </div>
    </div>
    `;
    
    elConfigContainer.insertAdjacentHTML('beforeend', html);
    setTimeout(() => { document.querySelector('.workspace-scroll-area').scrollBy({ top: 600, behavior: 'smooth' }); }, 100);

    document.getElementById('btn-download-assets').addEventListener('click', () => {
        const selected = Array.from(document.querySelectorAll('.asset-checkbox:checked')).map(cb => cb.value);
        if (selected.length === 0) {
            showToast("No assets selected.", "warning");
            return;
        }
        
        const params = {}; 
        currentTool.inputs.forEach(i => { 
            const el = document.getElementById(`input-${i.id}`); 
            if(el) params[i.id] = i.type === 'checkbox' ? el.checked : el.value; 
        });
        params['selected_assets'] = selected.join('|||');
        params['_pipeline_metadata'] = {
            post_processor: currentTool.post_processor || null,
            action_target: currentTool.action_target_tool || null
        };

        isExecuting = true;
        extractedAssets = []; 
        
        const btn = document.getElementById('exec-btn'); 
        btn.className = "btn-primary btn-danger"; 
        document.getElementById('btn-spinner').style.display = 'block'; 
        document.getElementById('btn-text').innerText = "Halt Protocol"; 
        document.getElementById('status-dot').className = 'status-indicator running'; 
        document.getElementById('status-text').innerText = 'Protocol Active';
        
        document.getElementById('terminal-drawer').classList.remove('collapsed');
        document.getElementById('console').innerHTML = `<div style="color:var(--tool-accent)">> ${appMetadata.app_name} Engine Initialized...</div>`; 
        logBuffer = [];

        fetch(`${LOCAL_ENGINE_URL}/api/run/${currentTool.id}`, { method: 'POST', body: JSON.stringify(params) })
            .then(res => {
                if (!res.ok) { res.json().then(data => showToast(data.error || 'Engine fault.', 'error')); resetExecutionState(); } 
                else { showToast('Download process initiated.', 'success'); }
            })
            .catch(e => { showToast('Network fault executing engine.', 'error'); resetExecutionState(); });
    });
}

// ⚡ PHASE 1 & 2: Overhauled Extractor UI with Explicit Material Tagging, Grid Layout & VJSON State Mapping
function renderExtractorResults() {
    const existing = document.getElementById('vdb-extractor-results');
    if (existing) existing.remove();
    
    const tagIcon = IconFactory.getIcon('ph-tag-duotone', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>', '18px');
    const arrowIcon = IconFactory.getIcon('ph-arrow-right-duotone', '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>', '16px');

    // ⚡ FIX: Evaluate if a VJSON was loaded via the input
    const vjsonInput = document.getElementById('input-vjson_template');
    const hasVjson = vjsonInput && vjsonInput.value.trim() !== "";

    let archetypesHtml = '';
    
    // ⚡ FIX: Render the VJSON card if ANY VJSON is loaded OR if archetypes were extracted
    if (hasVjson || vjsonArchetypes.length > 0) {
        let archRows = '';
        
        if (vjsonArchetypes.length > 0) {
            archRows = vjsonArchetypes.map(arch => `
                <div class="layer-mapping-row archetype-row" data-name="${arch}" style="display: grid; grid-template-columns: 1fr 140px; gap: 16px; align-items: center; background:var(--bg-input); padding: 8px 12px; border-radius:8px; margin-bottom:8px;">
                    <div class="layer-name-tag" style="font-family: inherit; font-size: 13px; font-weight: 600; border:none; padding:0; background:transparent;">${arch}</div>
                    <div class="segmented-control" style="height: 32px;">
                        <button type="button" class="segment-btn active" data-val="Metal" onclick="this.parentElement.querySelectorAll('.segment-btn').forEach(b=>b.classList.remove('active')); this.classList.add('active');">Metal</button>
                        <button type="button" class="segment-btn" data-val="Stone" onclick="this.parentElement.querySelectorAll('.segment-btn').forEach(b=>b.classList.remove('active')); this.classList.add('active');">Stone</button>
                    </div>
                </div>
            `).join('');
        } else {
            // ⚡ FIX: Render beautiful empty state informing the user the loaded VJSON has no existing configs
            archRows = `
                <div style="padding: 12px; color: var(--text-secondary); font-size: 12px; font-style: italic; background:var(--bg-input); border-radius:8px; margin-bottom:8px; border: 1px dashed var(--border-subtle);">
                    No existing taxonomies found in this template. A fresh configurator will be generated.
                </div>
            `;
        }
        
        archetypesHtml = `
            <div style="margin-bottom: 24px;">
                <div class="preview-list-header">VJSON Archetypes</div>
                <div style="display:flex; flex-direction:column;">${archRows}</div>
            </div>
        `;
    }

    let layersRows = extractedLayers.map(item => {
        const layer = typeof item === 'string' ? item : item.layer;
        const files = item.files || [];
        const count = files.length;
        const tooltip = files.join('&#10;');
        
        const badge = count > 0 ? `<span title="${tooltip}" style="font-size:9px; font-weight:700; background:var(--bg-surface); border:1px solid var(--border-subtle); padding:2px 6px; border-radius:4px; margin-left:8px; color:var(--text-secondary); cursor:help;">${count} File${count > 1 ? 's' : ''}</span>` : '';
        
        // Native fallback heuristic just for initial UI state
        const isStone = ['diamond', 'stone', 'gem', 'asscher', 'round', 'pear', 'oval', 'emerald', 'cushion', 'radiant', 'princess', 'marquise'].some(k => layer.toLowerCase().includes(k));
        
        // ⚡ FIX: Applied CSS Grid layout & Sans-serif typography override for precision spacing
        return `
        <div class="layer-mapping-row layer-row" data-original="${layer}" style="display: grid; grid-template-columns: 2.5fr 40px 2.5fr 140px; gap: 16px; align-items: center; background:var(--bg-input); padding: 8px 12px; border-radius:8px; margin-bottom: 8px;">
            <div class="layer-name-tag" style="font-family: inherit; font-size: 13px; font-weight: 600; border:none; padding:0; background:transparent; display: flex; align-items: center; justify-content: space-between;">
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${layer}</span>
                ${badge}
            </div>
            <div style="display:flex; justify-content: center; color:var(--text-secondary); opacity:0.5;">${arrowIcon}</div>
            <input type="text" class="liquid-input layer-map-input" data-original="${layer}" placeholder="New name (leave blank to retain)" style="height:32px; line-height:30px; min-width: 0;">
            <div class="segmented-control" style="height: 32px; min-width: 140px;">
                <button type="button" class="segment-btn ${!isStone ? 'active' : ''}" data-val="Metal" onclick="this.parentElement.querySelectorAll('.segment-btn').forEach(b=>b.classList.remove('active')); this.classList.add('active');">Metal</button>
                <button type="button" class="segment-btn ${isStone ? 'active' : ''}" data-val="Stone" onclick="this.parentElement.querySelectorAll('.segment-btn').forEach(b=>b.classList.remove('active')); this.classList.add('active');">Stone</button>
            </div>
        </div>
        `;
    }).join('');

    const html = `
    <div id="vdb-extractor-results" class="results-card" style="margin-top:20px;">
        <div class="results-header">
            <div class="results-title">
                ${tagIcon}
                Taxonomy Configuration
            </div>
        </div>
        <div class="results-body">
            ${archetypesHtml}
            <div>
                <div class="preview-list-header">Extracted Model Layers</div>
                ${layersRows}
            </div>
        </div>
        <div class="results-footer" style="gap:10px;">
            <button class="btn-secondary" id="btn-copy-layers">Copy Original Layers</button>
            <button class="btn-primary" id="btn-update-layers" style="height:38px;">Apply Config & Sync...</button>
        </div>
    </div>
    `;
    
    elConfigContainer.insertAdjacentHTML('beforeend', html);
    setTimeout(() => { document.querySelector('.workspace-scroll-area').scrollBy({ top: 600, behavior: 'smooth' }); }, 100);

    document.getElementById('btn-copy-layers').addEventListener('click', () => {
        const textToCopy = extractedLayers.map(item => typeof item === 'string' ? item : item.layer).join('\n');
        navigator.clipboard.writeText(textToCopy);
        showToast("Copied original layers to clipboard!", "success");
    });
    document.getElementById('btn-update-layers').addEventListener('click', showOverwriteModal);
}

function showOverwriteModal() {
    const existing = document.getElementById('vdb-action-modal');
    if(existing) existing.remove();

    const warnIcon = IconFactory.getIcon('ph-warning-octagon-duotone', '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', '24px');

    const modalHtml = `
    <div class="modal-root active" id="vdb-action-modal">
        <div class="modal-content">
            <div class="modal-header">
                ${warnIcon}
                <h2>Update Layers Protocol</h2>
            </div>
            <div class="modal-body">
                <p>You are about to seamlessly inject these new layer names into the 3D files.</p>
                <p><strong>Export as New:</strong> Prompts you to pick an output folder to generate fresh files.</p>
                <p style="color:var(--danger); margin-top:10px;"><strong>Overwrite Original:</strong> DANGER. This will atomically replace the source files. Cannot be undone.</p>
            </div>
            <div class="modal-actions">
                <button class="btn-secondary" id="modal-cancel">Cancel</button>
                <div class="modal-actions-right">
                    <button class="btn-secondary" style="color:var(--danger); border-color:rgba(255,69,58,0.3);" id="modal-overwrite">Overwrite Original</button>
                    <button class="btn-primary" id="modal-export" style="height:38px;">Export as New...</button>
                </div>
            </div>
        </div>
    </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('modal-cancel').addEventListener('click', () => { document.getElementById('vdb-action-modal').remove(); });
    document.getElementById('modal-overwrite').addEventListener('click', () => { document.getElementById('vdb-action-modal').remove(); triggerDirectUpdater(true); });
    document.getElementById('modal-export').addEventListener('click', () => { document.getElementById('vdb-action-modal').remove(); triggerDirectUpdater(false); });
}

async function triggerDirectUpdater(isOverwrite) {
    const directMap = {};
    let hasChanges = false;
    
    // Construct the deterministic taxonomy mapping payload
    const taxonomyMap = { archetypes: {}, layers: {} };
    
    document.querySelectorAll('.archetype-row').forEach(row => {
        const name = row.dataset.name;
        const tag = row.querySelector('.segment-btn.active').dataset.val;
        taxonomyMap.archetypes[name] = tag;
    });

    document.querySelectorAll('.layer-row').forEach(row => {
        const oldName = row.dataset.original;
        const input = row.querySelector('.layer-map-input');
        const newName = input.value.trim();
        const tag = row.querySelector('.segment-btn.active').dataset.val;
        
        if (newName && newName !== oldName) { 
            directMap[oldName] = newName; 
            hasChanges = true; 
        }
        
        // Note: The VJSON Sync needs the taxonomy of the *new* name if renamed, otherwise the *old* name.
        const effectiveName = (newName && newName !== oldName) ? newName : oldName;
        taxonomyMap.layers[effectiveName] = tag;
    });

    // Provide safety bypass if we ONLY want to sync VJSON taxonomies without renaming 3D files.
    if(!hasChanges && Object.keys(taxonomyMap.layers).length === 0) { 
        showToast("No configuration changes detected. Operation cancelled.", "warning"); 
        return; 
    }

    let outDir = "";
    if(!isOverwrite) {
        const res = await fetch(`${LOCAL_ENGINE_URL}/api/browse?type=folder`);
        const data = await res.json();
        if(!data.path) { showToast("Export cancelled.", "info"); return; }
        outDir = data.path;
    }

    const targetToolId = currentTool.action_target_tool;
    if (!targetToolId) { showToast("No target tool defined for this action.", "error"); return; }
    
    const updaterTool = allTools.find(t => t.id === targetToolId);
    if(!updaterTool) { showToast("Required target module is missing from the system.", "error"); return; }

    renderTool(updaterTool);
    setTimeout(() => {
        const elMap = document.getElementById('input-direct_map');
        if(elMap) elMap.value = JSON.stringify(directMap);
        
        // ⚡ Inject the new Deterministic Payload
        const elTaxonomy = document.getElementById('input-taxonomy_map');
        if(elTaxonomy) elTaxonomy.value = JSON.stringify(taxonomyMap);
        
        const elOverwrite = document.getElementById('input-overwrite_mode');
        if(elOverwrite) elOverwrite.value = isOverwrite ? "true" : "false";

        const elInput = document.getElementById('input-input_path');
        if(elInput) {
            elInput.value = currentContextPath;
            const disp = document.getElementById('display-input_path');
            if(disp) { disp.innerText = currentContextPath; disp.classList.add('has-value'); }
        }

        if(!isOverwrite && outDir) {
            const elOut = document.getElementById('input-output_dir');
            if(elOut) {
                elOut.value = outDir;
                const disp = document.getElementById('display-output_dir');
                if(disp) { disp.innerText = outDir; disp.classList.add('has-value'); }
            }
        }
        runTool();
    }, 150);
}

function initResizer() {
    let isResizing = false;
    elResizer.addEventListener('mousedown', () => { isResizing = true; elResizer.classList.add('active'); document.body.style.cursor = 'ew-resize'; });
    document.addEventListener('mousemove', (e) => { if (!isResizing) return; let w = window.innerWidth - e.clientX; elRightSidebar.style.width = `${Math.max(300, Math.min(800, w))}px`; });
    document.addEventListener('mouseup', () => { isResizing = false; elResizer.classList.remove('active'); document.body.style.cursor = ''; });
}

init();
connectSocket(); // Ensure the socket connects
