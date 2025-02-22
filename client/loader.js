/*
    DiepCustom - custom tank game server that shares diep.io's WebSocket protocol
    Copyright (C) 2022 ABCxFF (github.com/ABCxFF)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>
*/

window.Module = {};

Module.todo = [];

Module.status = null;
Module.isRunning = false;
Module.isAborted = false;
Module.exception = null;
Module.mainFunc = null;
Module.cp5 = null;
window.input = null;
Module.servers = null;
Module.tankDefinitions = null;
Module.tankDefinitionsTable = null;
Module.textInput = document.getElementById("textInput");
Module.textInputContainer = document.getElementById("textInputContainer");

Module.abort = cause => {
    Module.isAborted = true;
    Module.isRunning = false;
    throw new WebAssembly.RuntimeError(`abort(${cause})`);
};

Module.runASMConst = (code, sigPtr, argbuf) => {
    const args = [];
    let char;
    argbuf >>= 2;
    while(char = Module.HEAPU8[sigPtr++]) {
        const double = char < 105;
        if(double && argbuf & 1) argbuf++;
        args.push(double ? Module.HEAPF64[argbuf++ >> 1] : Module.HEAP32[argbuf])
        ++argbuf;
    }
    return ASMConsts[ASM_CONSTS[code]].apply(null, args);
};

Module.setLoop = func => {
    if(!Module.isRunning || Module.isAborted || Module.exception === "quit") return;
    Module.mainFunc = func;
    window.requestAnimationFrame(Module.loop);
};

Module.run = async () => {
    let args = [];
    while(Module.todo.length) {
        const [func, isAsync] = Module.todo.shift();
        if(isAsync) args = await Promise.all(func(...args));
        else args = func(...args);
        console.log(`Running stage ${Module.status} done`);
    }
};

Module.loop = () => {
    if(!Module.isRunning || Module.isAborted || Module.exception === "quit") return;
    switch(Module.exception) {
        case null:
            Module.exports.dynCallV(Module.mainFunc);
            return window.requestAnimationFrame(Module.loop);
        case "quit":
            return;
        case "unwind":
            Module.exception = null;
            return window.requestAnimationFrame(Module.loop);
    }
};

Module.exit = status => {
    Module.exception = "quit";
    Module.isRunning = false;
    throw `Stopped runtime with status ${status}`;
};

Module.UTF8ToString = ptr => ptr ? new TextDecoder().decode(Module.HEAPU8.subarray(ptr, Module.HEAPU8.indexOf(0, ptr))) : "";

Module.fdWrite = (stream, ptr, count, res) => {
    let out = 0;
    for(let i = 0; i < count; i++) out += Module.HEAP32[(ptr + (i * 8 + 4)) >> 2];
    Module.HEAP32[res >> 2] = out;
};

Module.allocateUTF8 = str => {
    if(!str) return 0;
    const encoded = new TextEncoder().encode(str);
    const ptr = Module.exports.malloc(encoded.byteLength + 1); // stringNT
    if(!ptr) return;
    Module.HEAPU8.set(encoded, ptr);
    Module.HEAPU8[ptr + encoded.byteLength] = 0;
    return ptr;
};

Module.loadGamemodeButtons = () => {
    const vec = new $.Vector(MOD_CONFIG.memory.gamemodeButtons, 'struct', 28);
    if(vec.start) vec.delete();
    vec.push(...Module.servers.map(server => ([{ offset: 0, type: 'cstr', value: server.gamemode }, { offset: 12, type: 'cstr', value: server.name }, { offset: 24, type: 'i32', value: 0 }])));
    Module.rawExports.loadVectorDone(MOD_CONFIG.memory.gamemodeButtons + 12);
};

Module.loadChangelog = () => {
    const vec = new $.Vector(MOD_CONFIG.memory.changelog, 'cstr', 12);
    if(vec.start) vec.delete();
    vec.push(...CHANGELOG);
    $(MOD_CONFIG.memory.changelogLoaded).i8 = 1;
};

Module.getTankDefinition = tankId => {
    if(!Module.tankDefinitions) return 0;
    if(!Module.tankDefinitionsTable) Module.loadTankDefinitions();
    if(!Module.tankDefinitionsTable[tankId]) return 0;
    return Module.tankDefinitionsTable[tankId] + 12;
};

Module.loadTankDefinitions = () => {
    const writeTankDef = (ptr, tank) => {
        // Please note that this is not the full tank/barrel struct but just the portion needed for the client to function properly
        const barrels = tank.barrels ? tank.barrels.map(barrel => {
            return [
                { offset: 0, type: "f32", value: barrel.angle },
                { offset: 4, type: "f32", value: barrel.delay },
                { offset: 8, type: "f32", value: barrel.size },
                { offset: 12, type: "f32", value: barrel.offset },
                { offset: 16, type: "u8", value: Number(barrel.isTrapezoid) },
                { offset: 24, type: "f32", value: barrel.width / 42 },
                { offset: 56, type: "f32", value: barrel.bullet.sizeRatio },
                { offset: 60, type: "f32", value: barrel.trapezoidDirection },
                { offset: 64, type: "f32", value: barrel.reload },
                { offset: 96, type: "u32", value: ADDON_MAP.barrelAddons[barrel.addon] || 0 }
            ];
        }) : [];

        const fields = [
            { offset: 4, type: "u32", value: tank.id },
            { offset: 8, type: "u32", value: tank.id },
            { offset: 12, type: "u32", value: tank.id },
            { offset: 16, type: "cstr", value: tank.name.toString() || "" },
            { offset: 28, type: "cstr", value: tank.upgradeMessage.toString() || "" },
            { offset: 40, type: "vector", value: { type: "u32", typeSize: 4, entries: tank.upgrades || [] } },
            { offset: 52, type: "vector", value: { type: "struct", typeSize: 100, entries: barrels } },
            { offset: 64, type: "u32", value: tank.levelRequirement || 0 },
            { offset: 76, type: "u8", value: Number(tank.sides === 4) },
            { offset: 93, type: "u8", value: Number(tank.sides === 16) },
            { offset: 96, type: "u32", value: ADDON_MAP.tankAddons[tank.preAddon] || 0 },
            { offset: 100, type: "u32", value: ADDON_MAP.tankAddons[tank.postAddon] || 0 },
        ];

        $.writeStruct(ptr, fields);
    };

    Module.tankDefinitionsTable = new Array(Module.tankDefinitions.length).fill(0);
    let lastPtr = MOD_CONFIG.memory.tankDefinitions;
    for(const tank of Module.tankDefinitions) {
        if(!tank) continue;
        const ptr = Module.exports.malloc(244);
        Module.HEAPU8.subarray(ptr, ptr + 244).fill(0);
        $(lastPtr).i32 = ptr;
        writeTankDef(ptr, tank);
        Module.tankDefinitionsTable[tank.id] = ptr;
        lastPtr = ptr;
    }

    $(MOD_CONFIG.memory.tankDefinitionsCount).i32 = Module.tankDefinitions.filter(e => Boolean(e)).length;
};

const wasmImports = {
    assertFail: (condition, filename, line, func) => Module.abort("Assertion failed: " + UTF8ToString(condition) + ", at: " + [filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function"]),
    mapFile: () => -1, // unused
    sysMunmap: (addr, len) => addr === -1 || !len ? -28 : 0, 
    abort: Module.abort,
    asmConstsDII: Module.runASMConst,
    asmConstsIII: Module.runASMConst,
    exitLive: () => Module.exception = "unwind", // unwind
    exitForce: () => Module.exit(1), // exit / quit
    getNow: () => performance.now(),
    memCopyBig: (dest, src, num) => { Module.HEAPU8.copyWithin(dest, src, src + num) }, // for large packets
    random: () => Math.random(),
    resizeHeap: () => Module.abort("OOM"), // unable to resize wasm memory
    setMainLoop: Module.setLoop,
    envGet: () => 0, // unused
    envSize: () => 0, // unused
    fdWrite: Module.fdWrite, // used for diep client console
    roundF: d => d >= 0 ? Math.floor(d + 0.5) : Math.ceil(d - 0.5),
    timeString: () => 0, // unused
    wasmMemory: new WebAssembly.Memory(WASM_MEMORY),
    wasmTable: new WebAssembly.Table(WASM_TABLE)
};

Module.todo.push([() => {
    Module.status = "PREPARE";
    Module.imports = { a: Object.fromEntries(Object.entries(WASM_IMPORTS).map(([key, name]) => [key, wasmImports[name]])) };
    return [];
}, false]);

Module.todo.push([() => {
    Module.status = "FETCH";
    return [fetch(`${CDN}build_${BUILD}.wasm.wasm`).then(res => res.arrayBuffer()), fetch(`${API_URL}servers`).then(res => res.json()), fetch(`${API_URL}tanks`).then(res => res.json())];
}, true]);

Module.todo.push([(dependency, servers, tanks) => {
    Module.status = "INSTANTIATE";
    Module.servers = servers;
    Module.tankDefinitions = tanks;
    
    const parser = new WailParser(new Uint8Array(dependency));
    
    const originalVectorDone = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadVectorDone);
    const originalLoadChangelog = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadChangelog);
    const originalLoadGamemodeButtons = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadGamemodeButtons);
    const originalLoadTankDefs = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.loadTankDefinitions);
    const originalGetTankDef = parser.getFunctionIndex(MOD_CONFIG.wasmFunctions.getTankDefinition);
    
    const loadGamemodeButtons = parser.addImportEntry({
        moduleStr: "mods",
        fieldStr: "loadGamemodeButtons",
        kind: "func",
        type: parser.addTypeEntry({
            form: "func",
            params: [],
            returnType: null
        })
    });

    const loadChangelog = parser.addImportEntry({
        moduleStr: "mods",
        fieldStr: "loadChangelog",
        kind: "func",
        type: parser.addTypeEntry({
            form: "func",
            params: [],
            returnType: null
        })
    });

    const getTankDefinition = parser.addImportEntry({
        moduleStr: "mods",
        fieldStr: "getTankDefinition",
        kind: "func",
        type: parser.addTypeEntry({
            form: "func",
            params: ["i32"],
            returnType: "i32"
        })
    });

    Module.imports.mods = {
        loadGamemodeButtons: Module.loadGamemodeButtons,
        loadChangelog: Module.loadChangelog,
        getTankDefinition: Module.getTankDefinition
    };

    parser.addExportEntry(originalVectorDone, {
        fieldStr: "loadVectorDone",
        kind: "func"
    });
    
    parser.addCodeElementParser(null, function({ index, bytes }) {
        switch(index) {
            case originalLoadChangelog.i32(): // we only need the part where it checks if the changelog is already loaded to avoid too many import calls
                return new Uint8Array([
                    ...bytes.subarray(0, MOD_CONFIG.wasmFunctionHookOffset.changelog),
                    OP_CALL, ...VarUint32ToArray(loadChangelog.i32()),
                    OP_RETURN,
                    ...bytes.subarray(MOD_CONFIG.wasmFunctionHookOffset.changelog)
                  ]);
            case originalLoadGamemodeButtons.i32(): // we only need the part where it checks if the buttons are already loaded to avoid too many import calls
                return new Uint8Array([
                    ...bytes.subarray(0, MOD_CONFIG.wasmFunctionHookOffset.gamemodeButtons),
                    OP_CALL, ...VarUint32ToArray(loadGamemodeButtons.i32()),
                    OP_RETURN,
                    ...bytes.subarray(MOD_CONFIG.wasmFunctionHookOffset.gamemodeButtons)
                ]);
            case originalGetTankDef.i32(): // we modify this to call a js function which then returns the tank def ptr from a table
                return new Uint8Array([
                    OP_GET_LOCAL, 0,
                    OP_CALL, ...VarUint32ToArray(getTankDefinition.i32()),
                    OP_RETURN,
                    OP_END
                ]);
            case originalLoadTankDefs.i32(): // we dont want this to run anymore because it will call the original tank wrapper function
                return new Uint8Array([
                    OP_END
                ]);
            default:
                return false;
        }
    });

    parser.parse();
    return [new Promise(resolve => WebAssembly.instantiate(parser.write(), Module.imports).then(res => resolve(res.instance), reason => Module.abort(reason)))];
}, true]);

Module.todo.push([instance => {
    Module.status = "INITIALIZE";
    Module.exports = Object.fromEntries(Object.entries(instance.exports).map(([key, func]) => [WASM_EXPORTS[key], func]));    
    Module.rawExports = instance.exports;
    Module.memBuf = wasmImports.wasmMemory.buffer,
    Module.HEAPU8 = new Uint8Array(Module.memBuf);
    Module.HEAP8 = new Int8Array(Module.memBuf);
    Module.HEAPU16 = new Uint16Array(Module.memBuf);
    Module.HEAP16 = new Int16Array(Module.memBuf);
    Module.HEAPU32 = new Uint32Array(Module.memBuf);
    Module.HEAP32 = new Int32Array(Module.memBuf);
    Module.HEAPF32 = new Float32Array(Module.memBuf);
    Module.HEAPF64 = new Float64Array(Module.memBuf);
    Module.HEAPU64 = new BigUint64Array(Module.memBuf);
    Module.HEAP64 = new BigInt64Array(Module.memBuf);
    Module.cp5 = {
        contexts: [],
        images: [],
        sockets: [],
        patterns: []
    };
    window.setupInput();
    window.setupDMA();
    return [];
}, false]);

Module.todo.push([() => {
    Module.status = "START";
    Module.HEAP32[DYNAMIC_TOP_PTR >> 2] = DYNAMIC_BASE;
    Module.isRunning = true;
    Module.exports.wasmCallCtors();
    Module.exports.main();
}, false]);

class ASMConsts {
    static createCanvasCtxWithAlpha(canvasId, alpha) {
        const canvas = document.getElementById(Module.UTF8ToString(canvasId));
        if(!canvas) return -1;
        const ctx = canvas.getContext("2d", {
            alpha: Boolean(alpha)
        });
        for (let i = 0; i < Module.cp5.contexts.length; ++i) {
            if (Module.cp5.contexts[i] !== null) continue;
            Module.cp5.contexts[i] = ctx;
            return i;
        }
        Module.cp5.contexts.push(ctx);
        return Module.cp5.contexts.length - 1;
    }

    static createImage(src) {
        const img = new Image;
        img.isLoaded = false;
        img.onload = () => img.isLoaded = true;
        img.src = `${CDN}${Module.UTF8ToString(src)}`;
        for (let i = 0; i < Module.cp5.images.length; ++i) {
            if (Module.cp5.images[i] !== null) continue;
            Module.cp5.images[i] = img;
            return i;
        }
        Module.cp5.images.push(img);
        return Module.cp5.images.length - 1;
    }

    static websocketSend(socketId, packetStart, packetLength) {
        const socket = Module.cp5.sockets[socketId];
        if(!socket || socket.readyState !== 1) return 0;
        try {
            socket.send(Module.HEAP8.subarray(packetStart, packetStart + packetLength));
        } catch(e) {}
        return 1;
    }

    static wipeContext(index) {
        Module.cp5.contexts[index] = null;
    }

    static modulo(a, b) {
        return a % b;
    }

    static wipeSocket(index) {
        const socket = Module.cp5.sockets[index];
        socket.onopen = socket.onclose = socket.onmessage = socket.onerror = function() {};
        for(let i = 0; i < socket.events.length; ++i) Module.exports.free(socket.events[i][1]);
        socket.events = null;
        try {
            socket.close();
        } catch(e) {}
        Module.cp5.sockets[index] = null;
    }

    static setTextInput(value) {
        Module.textInput.value = Module.UTF8ToString(value);
    }

    static wipeImage(index) {
        Module.cp5.images[index] = null;
    }

    static reloadWindowTimeout() {
        //setTimeout(() => window.location.reload(), 100);
    }

    static existsInWindowObject(key) {
        return Boolean(window[Module.UTF8ToString(key)]);
    }

    // 6 (ads)

    static getQueries() {
        const queryString = window.location.href.split("?")[0];
        return Module.allocateUTF8(queryString.slice(0, queryString.lastIndexOf("/")));
    }

    // 2 (ads)

    static getLocalStorage(key, length) {
        const str = window.localStorage[Module.UTF8ToString(key)] || "";
        Module.HEAPU32[length >> 2] = str.length;
        return Module.allocateUTF8(str);
    }

    static deleteLocalStorage(key) {
        delete window.localStorage[Module.UTF8ToString(key)];
    }

    static removeChildNode(nodeId) {
        const node = document.getElementById(Module.UTF8ToString(nodeId));
        if(node && node.parentNode) node.parentNode.removeChild(node);
    }

    static checkElementProperty(elementId, propertyKey, propertyIndex, value) {
        const element = document.getElementById(Module.UTF8ToString(elementId));
        const key = Module.UTF8ToString(propertyKey);
        if(!element || !element[key]) return true;
        return element[key][Module.UTF8ToString(propertyIndex)] === Module.UTF8ToString(value);
    }

    static existsQueryOrIsBlank(query) {
        const elements = document.querySelectorAll(Module.UTF8ToString(query));
        for(let i = 0; i < elements.length; ++i)
            if(elements[i].src === "about:blank") return true;
        return elements.length === 0;
    }

    // 1 (ads)

    static setLocalStorage(key, valueStart, valueLength) {
        window.localStorage[Module.UTF8ToString(key)] = new TextDecoder().decode(Module.HEAPU8.subarray(valueStart, valueStart + valueLength));
    }

    // 3 (ads)

    static getGamepad() {
        return window.navigator.getGamepads && window.navigator.getGamepads()[0]?.mapping === "standard";
    }

    static toggleFullscreen() {
        const requestMethod = document.body.requestFullScreen || document.body.webkitRequestFullScreen || document.body.mozRequestFullScreen || document.body.msRequestFullScreen;
        const cancelMethod = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if(!requestMethod && !cancelMethod) return;
        requestMethod ? requestMethod.call(document.body) : cancelMethod.call(document);
    }

    static getCanvasSize(ctxId, width, height) {
        const canvas = Module.cp5.contexts[ctxId].canvas;
        Module.HEAP32[width >> 2] = canvas.width;
        Module.HEAP32[height >> 2] = canvas.height;
    }

    static setCursorDefault() {
        document.getElementById("canvas").style.cursor = "default";
    }

    static setCursorPointer() {
        document.getElementById("canvas").style.cursor = "pointer";
    }

    static setCursorText() {
        document.getElementById("canvas").style.cursor = "text";
    }

    static getTextInput() {
        return Module.allocateUTF8(Module.textInput.value);
    }

    static enableTyping(left, top, width, height, enabled) {
        window.setTyping(true);
        Module.textInputContainer.style.display = "block";
        Module.textInputContainer.style.position = "absolute";
        Module.textInputContainer.style.left = window.unscale(left) + "px";
        Module.textInputContainer.style.top = window.unscale(top) + "px";
        Module.textInput.style.width = window.unscale(width * 0.96) + "px";
        Module.textInput.style.height = window.unscale(height) + "px";
        Module.textInput.style.lineHeight = window.unscale(height * 0.9) + "px";
        Module.textInput.style.fontSize = window.unscale(height * 0.9) + "px";
        Module.textInput.style.paddingLeft = "5px";
        Module.textInput.style.paddingRight = "5px";
        Module.textInput.disabled = !enabled;
        Module.textInput.focus();
    }

    static disableTyping() {
        window.setTyping(false);
        Module.textInput.blur();
        Module.textInput.value = "";
        Module.textInputContainer.style.display = "none";
    }

    static focusCanvas() {
        const canvas = document.getElementById("canvas");
        if(document.activeElement && document.activeElement !== canvas) document.activeElement.blur()
        canvas.focus();
    }

    static setCanvasSize(ctxId, width, height) {
        const canvas = Module.cp5.contexts[ctxId].canvas;
        canvas.width = width;
        canvas.height = height;
    }

    // 1 (ads)

    static copyUTF8(original) {
        return Module.allocateUTF8(Module.UTF8ToString(original));
    }

    static alert(text) {
        window.alert(Module.UTF8ToString(text));
    }

    static saveContext(ctxId) {
        Module.cp5.contexts[ctxId].save();
    }

    static restoreContext(ctxId) {
        Module.cp5.contexts[ctxId].restore();
    }

    static scaleContextAlpha(ctxId, alpha) {
        Module.cp5.contexts[ctxId].globalAlpha *= alpha;
    }

    // 5 (ads)

    static setContextFillStyle(ctxId, r, g, b) {
        Module.cp5.contexts[ctxId].fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    }

    static setContextTransform(ctxId, a, b, c, d, e, f) {
        Module.cp5.contexts[ctxId].setTransform(a, b, c, d, e, f);
    }

    static contextFillRect(ctxId) {
        Module.cp5.contexts[ctxId].fillRect(0, 0, 1, 1);
    }

    static contextBeginPath(ctxId) {
        Module.cp5.contexts[ctxId].beginPath();
    }

    static contextClip(ctxId) {
        Module.cp5.contexts[ctxId].clip();
    }

    static contextFill(ctxId) {
        Module.cp5.contexts[ctxId].fill();
    }

    static setContextLineJoinRound(ctxId) {
        Module.cp5.contexts[ctxId].lineJoin = "round";
    }

    static setContextLineJoinBevel(ctxId) {
        Module.cp5.contexts[ctxId].lineJoin = "bevel";
    }

    static setContextLineJoinMiter(ctxId) {
        Module.cp5.contexts[ctxId].lineJoin = "miter";
    }

    static setContextLineWidth(ctxId, width) {
        Module.cp5.contexts[ctxId].lineWidth = width;
    }

    static setContextStrokeStyle(ctxId, r, g, b) {
        Module.cp5.contexts[ctxId].strokeStyle = "rgb(" + r + "," + g + "," + b + ")";
    }

    static setContextTransformBounds(ctxId, a, b, c, d) {
        Module.cp5.contexts[ctxId].setTransform(a, b, c, d, 0, 0);
    }

    static contextStroke(ctxId) {
        Module.cp5.contexts[ctxId].stroke();
    }

    // draws one pixel
    static contextRect(ctxId) {
        Module.cp5.contexts[ctxId].rect(0, 0, 1, 1);
    }

    static getFontsLoaded() {
        return document.fonts.check("1px Ubuntu");
    }

    static setContextFont(ctxId, fontSize) {
        Module.cp5.contexts[ctxId].font = fontSize + "px Ubuntu";
    }

    static measureContextTextWidth(ctxId, text) {
        return Module.cp5.contexts[ctxId].measureText(Module.UTF8ToString(text)).width;
    }

    static setContextAlpha(ctxId, alpha) {
        Module.cp5.contexts[ctxId].globalAlpha = alpha;
    }

    static contextFillText(ctxId, text) {
        Module.cp5.contexts[ctxId].fillText(Module.UTF8ToString(text), 0, 0);
    }

    static contextStrokeText(ctxId, text) {
        Module.cp5.contexts[ctxId].strokeText(Module.UTF8ToString(text), 0, 0);
    }

    static setContextTextBaselineTop(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "top";
    }

    static setContextTextBaselineHanging(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "hanging";
    }

    static setContextTextBaselineMiddle(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "middle";
    }

    static setContextTextBaselineAlphabetic(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "alphabetic";
    }

    static setContextTextBaselineIdeographic(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "ideographic";
    }

    static setContextTextBaselineBottom(ctxId) {
        Module.cp5.contexts[ctxId].textBaseline = "bottom";
    }

    static setContextTransformNormalize(ctxId) {
        Module.cp5.contexts[ctxId].setTransform(1, 0, 0, 1, 0, 0);
    }

    static contextMoveTo(ctxId, x, y) {
        Module.cp5.contexts[ctxId].moveTo(x, y);
    }

    static contextLineTo(ctxId, x, y) {
        Module.cp5.contexts[ctxId].lineTo(x, y);
    }

    static contextClosePath(ctxId) {
        Module.cp5.contexts[ctxId].closePath();
    }

    static contextArc(ctxId, startAngle, endAngle, counterclockwise) {
        Module.cp5.contexts[ctxId].arc(0, 0, 1, startAngle, endAngle, counterclockwise)
    } 

    static copyToKeyboard(text) {
        window?.navigator?.clipboard?.writeText(Module.UTF8ToString(text));
    }

    static setLocation(newLocation) {
        window.localStorage = Module.UTF8ToString(newLocation);
    }

    static contextDrawImage(ctxId, imgId) {
        const img = Module.cp5.images[imgId];
        if(!img.isLoaded || img.width === 0 || img.height === 0) return;
        Module.cp5.contexts[ctxId].drawImage(img, 0, 0, img.width, img.height, 0, 0, 1, 1);
    }

    static getImage(imgId, isLoaded, width, height) {
        const img = Module.cp5.images[imgId];
        Module.HEAPU8[isLoaded >> 0] = img.isLoaded;
        Module.HEAP32[width >> 2] = img.width;
        Module.HEAP32[height >> 2] = img.height;
    }

    static contextDrawCanvas(ctxId, targetCtxId) {
        Module.cp5.contexts[ctxId].drawImage(Module.cp5.contexts[targetCtxId].canvas, 0, 0);
    }

    static setContextLineCapButt(ctxId) {
        Module.cp5.contexts[ctxId].lineCap = "butt";
    }

    static setContextLineCapRound(ctxId) {
        Module.cp5.contexts[ctxId].lineCap = "round";
    }

    static setContextLineCapSquare(ctxId) {
        Module.cp5.contexts[ctxId].lineCap = "square";
    }

    static contextStrokeRect(ctxId) {
        Module.cp5.contexts[ctxId].strokeRect(0, 0, 1, 1);
    }

    static contextDrawFullCanvas(ctxId, targetCtxId) {
        const canvas = Module.cp5.contexts[targetCtxId].canvas;
        Module.cp5.contexts[ctxId].drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 1, 1);
    }
    
    static isContextPatternAvailable() {
        return Boolean(CanvasRenderingContext2D.prototype.createPattern);
    }

    static createContextPattern(ctxId, targetCtxId) {
        const pattern = Module.cp5.contexts[ctxId].createPattern(Module.cp5.contexts[targetCtxId].canvas, null);
        for (let i = 0; i < Module.cp5.patterns.length; ++i) {
            if (Module.cp5.patterns[i] !== null) continue;
            Module.cp5.patterns[i] = pattern;
            return i;
        }
        Module.cp5.patterns.push(pattern);
        return Module.cp5.patterns.length - 1;
    }

    static contextGetPixelColor(ctxId, x, y) {
        const data = Module.cp5.contexts[ctxId].getImageData(x, y, 1, 1);
        return data.data[0] << 16 | data.data[1] << 8 | data.data[2];
    }

    static contextDrawCanvasSourceToPixel(ctxId, targetCtxId, x, y, w, h) {
        Module.cp5.contexts[ctxId].drawImage(Module.cp5.contexts[targetCtxId].canvas, x, y, w, h, 0, 0, 1, 1);
    }

    static contextFillRectWithPattern(ctxId, patternId, width, height) {
        Module.cp5.contexts[ctxId].fillStyle = Module.cp5.patterns[patternId];
        Module.cp5.contexts[ctxId].fillRect(0, 0, width, height);
    }

    static wipePattern(patternId) {
        Module.cp5.patterns[patternId] = null;
    }

    // 2 (verifying bootstrap integrity ?)

    static existsQuery(query) {
        return document.querySelector(Module.UTF8ToString(query)) !== null;
    }

    // 1 (anticheat)

    // used for shadow root
    static canvasHasSamePropertyAsDocumentBody(property) {
        const propertyKey = Module.UTF8ToString(property);
        return document.getElementById("canvas")[propertyKey] !== document.body[propertyKey];
    }

    // used for shadow root
    static existsDocumentBodyProperty(property) {
        return document.body[Module.UTF8ToString(property)] !== undefined;
    }

    // used for shadow root
    static existsDocumentBodyProperty2(property) {
        return Boolean(document.body[Module.UTF8ToString(property)]);
    }

    // used for shadow root
    static existsDivPropertyAndEqualsPropertyOnDocumentBody(propertyDiv, propertyBody) {
        const propertyDivKey = Module.UTF8ToString(propertyDiv);
        const div = document.createElement("div");
        if(!div[propertyDivKey]) return;
        return div[propertyDivKey]() === document.body[Module.UTF8ToString(propertyBody)];
    }

    // 3 (anticheat)

    // anticheat but need to be kept
    static acCheckWindow(property) {
        if(Module.UTF8ToString(property) === "navigator") return true;
    }

    static getDocumentBody() {
        return Module.allocateUTF8(document.body.innerHTML);
    }

    // 2 (anticheat)

    static getUserAgent() {
        return Module.allocateUTF8(window.navigator.userAgent);
    }

    // 1 (anticheat)

    static getQuerySelectorToString() {
        return Module.allocateUTF8("function querySelector() { [native code] }");
    }
    
    static getFillTextToString() {
        return Module.allocateUTF8("function fillText() { [native code] }");
    }

    static getStrokeRectToString() {
        return Module.allocateUTF8("function strokeRect() { [native code] }");
    }

    static getStrokeTextToString() {
        return Module.allocateUTF8("function strokeText() { [native code] }");
    }

    static getScaleToString() {
        return Module.allocateUTF8("function scale() { [native code] }");
    }

    static getTranslateToString() {
        return Module.allocateUTF8("function translate() { [native code] }");
    }

    static getFillRectToString() {
        return Module.allocateUTF8("function fillRect() { [native code] }");
    }

    static getRotateToString() {
        return Module.allocateUTF8("function rotate() { [native code] }");
    }

    static getGetImageDataToString() {
        return Module.allocateUTF8("function getImageData() { [native code] }");
    }

    // 1 (ads)

    static contextClearRect(ctxId) {
        const ctx = Module.cp5.contexts[ctxId];
        const canvas = ctx.canvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    static createCanvasCtx() {
        const ctx = document.createElement("canvas").getContext("2d");
        for(let i = 0; i < Module.cp5.contexts.length; ++i) {
            if(Module.cp5.contexts[i]) continue;
            Module.cp5.contexts[i] = ctx;
            return i; 
        }
        Module.cp5.contexts.push(ctx);
        return Module.cp5.contexts.length - 1;
    }

    static setContextMiterLimit(ctxId, miterLimit) {
        Module.cp5.contexts[ctxId].miterLimit = miterLimit;
    }

    static getWindowLocation() {
        return Module.allocateUTF8(window.location.hash);
    }

    static setLoadingStatus(status) {
        if(window.setLoadingStatus) window.setLoadingStatus(Module.UTF8ToString(status));
    }

    static m28nReply(requestId, endpoint) {
        const id = Module.allocateUTF8(Module.UTF8ToString(endpoint));
        const ipv4 = Module.allocateUTF8(Module.UTF8ToString(endpoint));
        const ipv6 = Module.allocateUTF8(Module.UTF8ToString(endpoint));
        Module.exports.restReply(requestId, id, ipv4, ipv6);
        Module.exports.free(id);
        Module.exports.free(ipv4);
        Module.exports.free(ipv6);
    }

    static isSSL() {
        return window.location.protocol === "https:";
    }

    static createWebSocket(url) {
        url = Module.UTF8ToString(url);
        if (url.split('.').length === 4) url = `ws${location.protocol.slice(4)}//${location.host}/game/${url.slice(url.indexOf("//") + 2, url.indexOf('.'))}`;
        else if (url.endsWith(":443")) url = `ws${location.protocol.slice(4)}//${location.host}/game/${url.slice(url.indexOf("//") + 2, url.length - 4)}`
        else return prompt("Error loading into game. Take a picture of this then send to our support server (github.com/ABCxFF/diepcustom)", url);
    
        const ws = new WebSocket(url);
        window.ws = ws;
        ws.binaryType = "arraybuffer";
        ws.events = [];
        ws.onopen = function() {
            ws.events.push([2, 0, 0]);
            Module.exports.checkWS();
        };
        ws.onerror = function() {
            ws.events.push([3, 0, 0]);
            Module.exports.checkWS();
        };
        ws.onclose = function() {
            ws.events.push([4, 0, 0]);
            Module.exports.checkWS();
        };
        ws.onmessage = function(e) {
            const view = new Uint8Array(e.data);
            const ptr = Module.exports.malloc(view.length);
            Module.HEAP8.set(view, ptr);
            ws.events.push([1, ptr, view.length]);
            Module.exports.checkWS();
        };
        for (let i = 0; i < Module.cp5.sockets.length; ++i) {
            if (Module.cp5.sockets[i] != null)
                continue;
            Module.cp5.sockets[i] = ws;
            return i;
        }
        Module.cp5.sockets.push(ws);
        return Module.cp5.sockets.length - 1;
    }

    static findServerById(requestId, endpoint) {
        Module.exports.restReply(requestId, 0, 0, 0);
    }

    static invalidPartyId() {
        alert("Invalid party ID");
    }

    static wipeLocation() {
        window.location.hash = "";
    }

    static getGamepadAxe(axeId) {
        const axes = window.navigator.getGamepads()[0].axes;
        if(axeId >= axes.length) return;
        return axes[axeId];
    }

    static getGamepadButtonPressed(buttonId) {
        const buttons = window.navigator.getGamepads()[0].buttons;
        if(buttonId >= buttons.length) return;
        return buttons[buttonId].pressed;
    }

    static pollWebSocketEvent(socketId, msg, length) {
        const ws = Module.cp5.sockets[socketId];
        if(ws.events.length === 0) return null;
        const event = ws.events.shift();
        Module.HEAPU32[msg >> 2] = event[1]; // packet ptr
        Module.HEAP32[length >> 2] = event[2]; // packet length
        return event[0]; // type
    }

    static updateToNewVersion(version) {
        console.log(Module.UTF8ToString(version));
        setTimeout(() => window.location.reload());
    }

    // 1 (pow)

    static reloadWindow() {
        setTimeout(() => window.location.reload());
    }

    static getWindowLocationSearch() {
        return Module.allocateUTF8(window.location.search);
    }

    static getWindowReferrer() {
        return Module.allocateUTF8(window.document.referrer);
    }

    // 7 (fingerprinting)

    static empty() {}
}

Module.run();
