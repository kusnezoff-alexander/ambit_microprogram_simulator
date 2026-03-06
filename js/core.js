// PIM Microprogram Visualizer - Core Engine
// Shared infrastructure for all PIM backends (Ambit, ReRAM, etc.)

// ============================================================
// Backend Registry
// ============================================================

const backends = {};

function registerBackend(backend) {
    backends[backend.name] = backend;
}

// ============================================================
// Global State
// ============================================================

let activeBackend = null;
let program = null;
let pc = 0;
let registers = {};
let bitWidth = 4;
let activatedCells = new Set();   // Cells activated by current instruction
let previousCells = new Set();    // Cells from previous instruction (shown dimmed)
let scrollOffset = 0;             // Scroll position for row window
const MAX_VISIBLE_ROWS = 16;      // Maximum rows to show at once
const programs = {};               // Loaded programs keyed by name

// ============================================================
// Initialization
// ============================================================

async function init() {
    // Build tab bar from registered backends
    buildTabBar();

    // Default to first registered backend
    const backendNames = Object.keys(backends);
    if (backendNames.length > 0) {
        switchBackend(backendNames[0]);
    }
}

function buildTabBar() {
    const tabBar = document.getElementById('tabBar');
    tabBar.innerHTML = '';
    for (const name of Object.keys(backends)) {
        const btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.textContent = name;
        btn.onclick = () => switchBackend(name);
        btn.id = 'tab-' + name;
        tabBar.appendChild(btn);
    }
}

function switchBackend(name) {
    if (!backends[name]) return;
    activeBackend = backends[name];

    // Update tab highlight
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.id === 'tab-' + name);
    });

    // Update memory array label
    document.getElementById('memoryLabel').textContent = activeBackend.memoryLabel;

    // Rebuild timing inputs
    buildTimingInputs();

    // Reload program list
    loadProgramList();

    // Hide main display and reset state
    document.getElementById('main').style.display = 'none';
    program = null;
    pc = 0;
    registers = {};
}

function buildTimingInputs() {
    const container = document.getElementById('timingInputs');
    container.innerHTML = '';
    for (const [instrType, defaultVal] of Object.entries(activeBackend.timingDefaults)) {
        const label = document.createElement('label');
        label.innerHTML = `t<sub>${instrType}</sub>: `;
        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'timing-' + instrType;
        input.value = defaultVal;
        input.style.cssText = 'width:60px; padding:4px;';
        input.oninput = updateStats;
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ns'));
        container.appendChild(label);
    }
}

async function loadProgramList() {
    const select = document.getElementById('program');
    select.innerHTML = '<option value="">-- Select --</option>';

    // Clear previously loaded programs for this backend
    for (const key of Object.keys(programs)) {
        delete programs[key];
    }

    const ext = activeBackend.programExt || '.txt';

    for (const name of activeBackend.programNames) {
        try {
            const resp = await fetch(activeBackend.programDir + '/' + name + ext);
            if (resp.ok) {
                const prog = activeBackend.parseProgram(await resp.text());
                programs[name] = prog;

                // Build label from program metadata or filename
                let label;
                if (prog.benchmark) {
                    label = prog.benchmark;
                } else {
                    const bitwidthMatch = name.match(/(\d+)$/);
                    const bitwidth = bitwidthMatch ? bitwidthMatch[1] + '-bit' : '';
                    label = bitwidth ? `${name} (${bitwidth})` : name;
                }

                const option = document.createElement('option');
                option.value = name;
                option.textContent = label;
                select.appendChild(option);
            }
        } catch (e) {
            console.log('Error loading', name, e);
        }
    }
    console.log(`${activeBackend.name} backend: loaded ${Object.keys(programs).length} programs`);
}

// ============================================================
// Input Parsing
// ============================================================

function parseInput(str) {
    str = str.trim();

    // Nested array format: [[1,2,3,4],[5,6,7,8]]
    if (str.startsWith('[[') && str.endsWith(']]')) {
        const inner = str.slice(2, -2);
        const operandStrings = inner.split('],[').map(s => s.replace(/[\[\]]/g, ''));
        const operands = operandStrings.map(partsStr => {
            return partsStr.split(',').map(s => {
                s = s.trim();
                if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
                return parseInt(s, 10) || 0;
            });
        });
        return { isNested: true, operands: operands };
    }

    // Simple array format: [5,3]
    if (str.startsWith('[') && str.endsWith(']')) {
        const inner = str.slice(1, -1);
        return inner.split(',').map(s => {
            s = s.trim();
            if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
            return parseInt(s, 10) || 0;
        });
    }

    if (str.startsWith('0x') || str.startsWith('0X')) return parseInt(str, 16);
    return parseInt(str, 10) || 0;
}

// ============================================================
// Random Input Generation
// ============================================================

function generateRandom() {
    const name = document.getElementById('program').value;
    if (!name) return;

    const prog = programs[name];
    let bw, numOperands;

    if (prog && prog.inputMap) {
        // ReRAM / SIMPLER-MAGIC: derive from metadata
        const info = deriveOperandInfo(prog);
        bw = info.bitsPerOperand;
        numOperands = info.numOperands;
    } else {
        // Ambit: derive from filename
        if (name === 'fa') { bw = 1; }
        else { bw = parseInt(name.replace(/\D/g, '')); }
        numOperands = 1;
        if (name.startsWith('add') || name.startsWith('sub') || name.startsWith('mul') ||
            name.startsWith('min') || name.startsWith('max') || name.startsWith('gt') ||
            name.startsWith('ge') || name.startsWith('eq') || name.startsWith('ifelse')) {
            numOperands = 2;
        }
    }

    bitWidth = bw;

    // For ReRAM, generate multiple SIMD lanes; for Ambit, generate a single value
    // (Ambit columns are bit positions, not independent lanes)
    const isReRAM = prog && prog.inputMap;
    const numLanes = isReRAM ? 4 : 1;

    if (numOperands > 1) {
        const operands = [];
        for (let op = 0; op < numOperands; op++) {
            const vals = [];
            for (let lane = 0; lane < numLanes; lane++) vals.push(randomValue(bw));
            operands.push('[' + vals.join(',') + ']');
        }
        document.getElementById('inputVal').value = '[' + operands.join(',') + ']';
    } else if (numLanes > 1) {
        const vals = [];
        for (let lane = 0; lane < numLanes; lane++) vals.push(randomValue(bw));
        document.getElementById('inputVal').value = '[' + vals.join(',') + ']';
    } else {
        document.getElementById('inputVal').value = randomValue(bw);
    }

    document.getElementById('inputVal').style.border = '';
    document.getElementById('loadBtn').disabled = false;
    document.getElementById('stepBtn').disabled = false;
    document.getElementById('runBtn').disabled = false;
}

// Derive operand count and bits-per-operand from SIMPLER-MAGIC inputMap
function deriveOperandInfo(prog) {
    const inputMap = prog.inputMap;
    if (!inputMap || inputMap.length === 0) return { numOperands: 1, bitsPerOperand: 1 };

    // Group by prefix (A0,A1..A7 = one operand, B0..B7 = another, Cin = third, etc.)
    const groups = [];
    let currentPrefix = null;
    let currentCount = 0;
    for (const inp of inputMap) {
        const prefix = inp.name.replace(/\d+$/, '');
        if (prefix !== currentPrefix) {
            if (currentPrefix !== null) {
                groups.push({ prefix: currentPrefix, count: currentCount });
            }
            currentPrefix = prefix;
            currentCount = 0;
        }
        currentCount++;
    }
    if (currentPrefix !== null) {
        groups.push({ prefix: currentPrefix, count: currentCount });
    }

    // Heuristic: if all groups have the same size, that's the bitwidth and
    // the number of groups is the operand count. If there's an odd one out
    // (like Cin with count 1), treat the majority size as the bitwidth.
    const sizes = groups.map(g => g.count);
    const maxSize = Math.max(...sizes);
    const numOperands = groups.filter(g => g.count === maxSize).length;
    return { numOperands, bitsPerOperand: maxSize };
}

function randomValue(bw) {
    if (bw >= 32) {
        if (Math.random() < 0.3) {
            return 0x80000000 + Math.floor(Math.random() * 0x80000000);
        }
        return Math.floor(Math.random() * 0x7FFFFFFF);
    }
    const maxSigned = 1 << (bw - 1);
    if (Math.random() < 0.3) {
        return maxSigned + Math.floor(Math.random() * maxSigned);
    }
    return Math.floor(Math.random() * maxSigned);
}

// ============================================================
// Program Loading & Register Initialization
// ============================================================

function loadProgram() {
    const name = document.getElementById('program').value;
    const inputStr = document.getElementById('inputVal').value.trim();

    if (!name || !programs[name]) {
        alert('Program not loaded: ' + name);
        return;
    }

    const prog = programs[name];

    // Determine if binary operation and bitwidth
    let isBinaryOp;
    if (prog.inputMap) {
        // ReRAM: derive from metadata
        const info = deriveOperandInfo(prog);
        isBinaryOp = info.numOperands > 1;
        bitWidth = info.bitsPerOperand;
    } else {
        // Ambit: derive from filename
        isBinaryOp = name.startsWith('add') || name.startsWith('sub') ||
            name.startsWith('mul') || name.startsWith('min') || name.startsWith('max') ||
            name.startsWith('gt') || name.startsWith('ge') || name.startsWith('eq') ||
            name.startsWith('ifelse');
        if (name === 'fa') { bitWidth = 1; }
        else { bitWidth = parseInt(name.replace(/\D/g, '')); }
    }

    // Validate input format for binary operations
    if (isBinaryOp && (!inputStr.startsWith('[[') || !inputStr.endsWith(']]'))) {
        document.getElementById('inputVal').style.border = '2px solid red';
        document.getElementById('loadBtn').disabled = true;
        document.getElementById('stepBtn').disabled = true;
        document.getElementById('runBtn').disabled = true;
        return;
    }

    document.getElementById('inputVal').style.border = '';
    document.getElementById('loadBtn').disabled = false;
    document.getElementById('stepBtn').disabled = false;
    document.getElementById('runBtn').disabled = false;

    program = prog;
    pc = 0;

    // Parse input values
    const inputArray = parseInputArray(inputStr);

    // Initialize registers via backend-specific method if available,
    // otherwise use the default (Ambit-style vertical) initialization
    registers = {};
    scrollOffset = 0;
    activatedCells = new Set();
    previousCells = new Set();

    if (activeBackend.initRegisters) {
        activeBackend.initRegisters(program, inputArray, isBinaryOp, bitWidth, registers);
    } else {
        initRegistersDefault(program, inputArray, isBinaryOp);
    }

    // Show main area
    document.getElementById('main').style.display = 'block';
    document.getElementById('stepBtn').disabled = false;
    document.getElementById('runBtn').disabled = false;
    document.getElementById('resetBtn').disabled = false;

    render();
}

// Parse input string into a usable array structure
function parseInputArray(inputStr) {
    if (inputStr.startsWith('[[') && inputStr.endsWith(']]')) {
        const inner = inputStr.slice(2, -2);
        const operandStrings = inner.split('],[').map(s => s.replace(/[\[\]]/g, ''));
        const operands = operandStrings.map(partsStr => {
            return partsStr.split(',').map(s => {
                s = s.trim();
                if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
                return parseInt(s, 10) || 0;
            });
        });
        const maxLen = Math.max(...operands.map(o => o.length));
        const result = [];
        for (let c = 0; c < maxLen; c++) {
            result.push(operands.map(op => op[c] || 0));
        }
        return result;
    } else if (inputStr.startsWith('[') && inputStr.endsWith(']')) {
        const inner = inputStr.slice(1, -1);
        return inner.split(',').map(s => {
            s = s.trim();
            if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
            return parseInt(s, 10) || 0;
        });
    } else if (inputStr.startsWith('0x') || inputStr.startsWith('0X')) {
        return [parseInt(inputStr, 16)];
    } else {
        return [parseInt(inputStr, 10) || 0];
    }
}

// Default (Ambit-style vertical) register initialization
function initRegistersDefault(program, inputArray, isBinaryOp) {
    const numCols = bitWidth;
    const allRows = getAllRowNames(program);

    for (const rowName of allRows) {
        if (rowName.startsWith('I')) {
            const inputIdx = parseInt(rowName.slice(1));
            registers[rowName] = new Array(numCols).fill(0);

            if (isBinaryOp) {
                const maxCol = Math.min(inputArray.length, numCols);
                for (let col = 0; col < maxCol; col++) {
                    const colData = inputArray[col];
                    if (Array.isArray(colData)) {
                        for (let opIdx = 0; opIdx < colData.length; opIdx++) {
                            const operandVal = colData[opIdx];
                            const startInputIdx = opIdx * bitWidth;
                            if (inputIdx >= startInputIdx && inputIdx < startInputIdx + bitWidth) {
                                const bitPos = inputIdx - startInputIdx;
                                registers[rowName][col] = (operandVal >> bitPos) & 1;
                            }
                        }
                    }
                }
            } else {
                for (let col = 0; col < inputArray.length && col < numCols; col++) {
                    const colData = inputArray[col];
                    if (Array.isArray(colData)) {
                        let val = 0;
                        for (const v of colData) { val |= ((v >> inputIdx) & 1); }
                        registers[rowName][col] = val;
                    } else {
                        registers[rowName][col] = (colData >> inputIdx) & 1;
                    }
                }
            }
        } else if (rowName.startsWith('O')) {
            registers[rowName] = new Array(numCols).fill(null);
        } else if (rowName === 'C0') {
            registers[rowName] = new Array(numCols).fill(0);
        } else if (rowName === 'C1') {
            registers[rowName] = new Array(numCols).fill(1);
        } else {
            registers[rowName] = new Array(numCols).fill(null);
        }
    }
}

// ============================================================
// Register Access
// ============================================================

function getReg(reg, col) {
    let neg = false;
    if (reg.startsWith('~')) { reg = reg.slice(1); neg = true; }
    if (!registers[reg]) return neg ? 1 : 0;
    let v = registers[reg][col];
    if (v === undefined || v === null) v = 0;
    return neg ? 1 - v : v;
}

function setReg(reg, col, val) {
    let neg = false;
    if (reg.startsWith('~')) { reg = reg.slice(1); neg = true; }
    if (!registers[reg]) registers[reg] = new Array(bitWidth).fill(null);
    registers[reg][col] = neg ? 1 - val : val;
}

// ============================================================
// Instruction Execution
// ============================================================

function stepInstruction() {
    if (pc >= program.instrs.length) return;
    const instr = program.instrs[pc];
    activeBackend.stepInstruction(instr, registers, bitWidth, getReg, setReg);
    pc++;
}

function step() {
    previousCells = new Set(activatedCells);
    if (pc < program.instrs.length) {
        activatedCells = getActivatedCells(program.instrs[pc]);
    } else {
        activatedCells = new Set();
    }
    stepInstruction();
    render();
}

function runAll() {
    while (pc < program.instrs.length) {
        previousCells = new Set(activatedCells);
        activatedCells = getActivatedCells(program.instrs[pc]);
        stepInstruction();
    }
    pc = program.instrs.length;
    previousCells = new Set(activatedCells);
    activatedCells = new Set();
    render();
}

function reset() {
    loadProgram();
}

function jumpTo(n) {
    loadProgram();
    while (pc < n) stepInstruction();
    if (pc < program.instrs.length) {
        activatedCells = getActivatedCells(program.instrs[pc]);
    } else {
        activatedCells = new Set();
    }
    render();
}

// ============================================================
// Row/Cell Analysis Helpers
// ============================================================

// Extract activated row names from an instruction (for highlighting)
// Backends can override via getActivatedRows; default handles bracket syntax.
function getActivatedCells(instr) {
    if (activeBackend.getActivatedCells) {
        return activeBackend.getActivatedCells(instr, registers);
    }
    // Default: extract row names (Ambit-style)
    const rows = new Set();
    if (!instr) return rows;
    for (const arg of instr.args) {
        if (arg.startsWith('[') && arg.endsWith(']')) {
            const parts = arg.slice(1, -1).split(',').map(s => s.trim());
            for (const part of parts) {
                const clean = part.replace(/^~/, '');
                if (clean) rows.add(clean);
            }
        } else {
            const clean = arg.replace(/^~/, '');
            if (clean) rows.add(clean);
        }
    }
    return rows;
}

function getAllRowNames(program) {
    const rows = new Set();
    rows.add('C0');
    rows.add('C1');
    for (const instr of program.instrs) {
        const cells = getActivatedCells(instr);
        for (const cell of cells) {
            rows.add(cell);
        }
    }
    return rows;
}

function parseRowName(name) {
    const match = name.match(/^([A-Z]+)(\d+)$/);
    if (!match) return { type: name, index: 0 };
    return { type: match[1], index: parseInt(match[2]) };
}

function sortRowNames(names) {
    const typeOrder = { 'I': 0, 'O': 1, 'C': 2, 'T': 3, 'S': 4, 'DCC': 5 };
    return Array.from(names).sort((a, b) => {
        const pa = parseRowName(a);
        const pb = parseRowName(b);
        const orderA = typeOrder[pa.type] ?? 6;
        const orderB = typeOrder[pb.type] ?? 6;
        if (orderA !== orderB) return orderA - orderB;
        return pa.index - pb.index;
    });
}

// ============================================================
// Rendering
// ============================================================

function renderRow(reg, numCols) {
    const vals = registers[reg];
    if (!vals) return '';
    const isActivated = activatedCells.has(reg);
    const isPrevious = previousCells.has(reg) && !isActivated;
    let rowBg, rowBorder;
    if (isActivated) {
        rowBg = '#fff3cd'; rowBorder = 'border-left: 4px solid #ffc107;';
    } else if (isPrevious) {
        rowBg = '#e8f4fd'; rowBorder = 'border-left: 4px solid #17a2b8;';
    } else {
        rowBg = '#e7f3ff'; rowBorder = '';
    }
    let html = `<tr style="${rowBorder}"><td style="padding:6px 8px;background:${rowBg};font-weight:bold; font-family:monospace;">${reg}</td>`;
    for (let c = 0; c < numCols; c++) {
        const v = vals[c];
        let bg = v === 1 ? '#d4edda' : v === 0 ? '#f8d7da' : '#f5f5f5';
        const color = v === 1 ? '#28a745' : v === 0 ? '#dc3545' : '#333';
        if (isActivated) {
            bg = v === 1 ? '#c3e6cb' : v === 0 ? '#f5c6cb' : '#e9ecef';
        } else if (isPrevious) {
            bg = v === 1 ? '#c8e6c9' : v === 0 ? '#f5c6cb' : '#e0e0e0';
        }

        // For ReRAM, highlight individual column cells if they are activated
        let cellHighlight = '';
        if (activeBackend.highlightColumns) {
            const colKey = 'col:' + c;
            if (activatedCells.has(colKey)) {
                bg = v === 1 ? '#c3e6cb' : v === 0 ? '#f5c6cb' : '#e9ecef';
                cellHighlight = 'border: 2px solid #ffc107;';
            } else if (previousCells.has(colKey)) {
                bg = v === 1 ? '#c8e6c9' : v === 0 ? '#f5c6cb' : '#e0e0e0';
                cellHighlight = 'border: 2px solid #17a2b8;';
            }
        }

        html += `<td style="padding:6px 8px;background:${bg};color:${color};text-align:center; font-family:monospace;${cellHighlight}">${v === null ? '?' : v}</td>`;
    }
    html += '</tr>';
    return html;
}

function renderEllipsis(numCols, label) {
    return '<tr><td colspan="' + (numCols + 1) + '" style="text-align:center; padding:2px; background:#f0f0f0; color:#999; font-size:12px;">&#x22EE; ' + label + '</td></tr>';
}

function renderHeader(numCols, label) {
    let html = '<tr><th style="padding:6px 8px;background:#007bff;color:white; min-width:80px;">' + label + '</th>';
    for (let c = 0; c < numCols; c++) {
        html += `<th style="padding:6px 8px;background:#007bff;color:white; width:50px;">${c}</th>`;
    }
    html += '</tr>';
    return html;
}

function render() {
    if (!program) return;

    // Delegate to backend-specific renderer if available, otherwise use default
    if (activeBackend.render) {
        activeBackend.render(program, registers, bitWidth, pc, activatedCells, previousCells, scrollOffset);
    } else {
        renderDefault();
    }

    // Render instructions (shared across all backends)
    renderInstructions();

    // Render statistics
    updateStats();

    // Render result
    renderResult();
}

function renderDefault() {
    const numCols = bitWidth;
    const allRegNames = sortRowNames(Object.keys(registers));

    // Split rows into compute (T*, DCC*) and data (I*, O*, C*, S*)
    const computeRows = [];
    const dataRows = [];
    for (const reg of allRegNames) {
        if (reg.startsWith('T') || reg.startsWith('DCC')) {
            computeRows.push(reg);
        } else {
            dataRows.push(reg);
        }
    }

    const MAX_DATA_ROWS = 16;
    const dataIndicesToShow = new Set();

    // Always show output rows
    for (let i = 0; i < dataRows.length; i++) {
        if (dataRows[i].startsWith('O')) dataIndicesToShow.add(i);
    }

    // Show activated rows
    const allRelevantRows = new Set([...activatedCells, ...previousCells]);
    for (const row of allRelevantRows) {
        const idx = dataRows.indexOf(row);
        if (idx !== -1) dataIndicesToShow.add(idx);
    }

    // Fill with scroll window
    if (dataIndicesToShow.size < MAX_DATA_ROWS) {
        const maxScroll = Math.max(0, dataRows.length - MAX_DATA_ROWS);
        scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
        for (let i = scrollOffset; i < Math.min(scrollOffset + MAX_DATA_ROWS, dataRows.length); i++) {
            dataIndicesToShow.add(i);
        }
    }

    const sortedDataIndices = Array.from(dataIndicesToShow).sort((a, b) => a - b);

    let html = '<div>';
    html += `<div style="font-size:12px; color:#666; margin-bottom:4px;">${allRegNames.length} rows total</div>`;

    const maxScroll = Math.max(0, dataRows.length - MAX_DATA_ROWS);
    html += '<div style="display:flex; gap:10px; margin-bottom:6px; align-items:center;">';
    html += `<button onclick="scrollRows(-4)" style="padding:4px 10px;" ${scrollOffset <= 0 ? 'disabled' : ''}>&uarr;</button>`;
    html += `<button onclick="scrollRows(4)" style="padding:4px 10px;" ${scrollOffset >= maxScroll ? 'disabled' : ''}>&darr;</button>`;
    html += '</div>';

    html += '<table border="1" style="border-collapse:collapse; width:100%;">';
    html += renderHeader(numCols, 'Data Rows');

    if (sortedDataIndices.length > 0 && sortedDataIndices[0] > 0) {
        html += renderEllipsis(numCols, sortedDataIndices[0] + ' rows above');
    }

    for (let si = 0; si < sortedDataIndices.length; si++) {
        const idx = sortedDataIndices[si];
        if (si > 0 && idx - sortedDataIndices[si - 1] > 1) {
            html += renderEllipsis(numCols, (idx - sortedDataIndices[si - 1] - 1) + ' rows');
        }
        html += renderRow(dataRows[idx], numCols);
    }

    if (sortedDataIndices.length > 0 && sortedDataIndices[sortedDataIndices.length - 1] < dataRows.length - 1) {
        html += renderEllipsis(numCols, (dataRows.length - 1 - sortedDataIndices[sortedDataIndices.length - 1]) + ' rows below');
    }

    html += '</table>';

    // Compute rows
    html += '<table border="1" style="border-collapse:collapse; width:100%; margin-top:8px;">';
    html += renderHeader(numCols, 'Compute Rows');
    for (const reg of computeRows) {
        html += renderRow(reg, numCols);
    }
    html += '</table></div>';

    document.getElementById('memory').innerHTML = html;
}

function renderInstructions() {
    let instrHtml = '';
    for (let i = 0; i < program.instrs.length; i++) {
        const instr = program.instrs[i];
        let cls = 'instr';
        if (i < pc) cls += ' past';
        if (i === pc) cls += ' current';

        let label;
        if (instr.type === 'init' && instr.cells) {
            // Collapsible init instruction: show compact summary,
            // expand full cell list on click (without navigating)
            const cycle = instr.cycle || 'T' + i;
            const n = instr.cells.length;
            const detailId = 'init-detail-' + i;
            label = `<b>${cycle}</b> `
                + `<span class="init-summary" onclick="event.stopPropagation(); toggleInit('${detailId}')">`
                + `INIT ${n} cells &#x25B6;</span>`
                + `<span id="${detailId}" class="init-detail" style="display:none;">`
                + `<br>${instr.display}`
                + `</span>`;
        } else if (instr.display) {
            label = `<b>${instr.cycle || 'T' + i}</b> ${instr.display}`;
        } else {
            label = `${instr.type} ${instr.args.join(' ')}`;
        }
        instrHtml += `<div class="${cls}" onclick="jumpTo(${i})">${label}</div>`;
    }
    document.getElementById('instructions').innerHTML = instrHtml;
    document.getElementById('counter').textContent = `${pc} / ${program.instrs.length}`;

    const current = document.querySelector('.instr.current');
    if (current) current.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function toggleInit(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const isHidden = el.style.display === 'none';
    el.style.display = isHidden ? 'inline' : 'none';
    // Toggle the arrow on the summary
    const summary = el.previousElementSibling;
    if (summary && summary.classList.contains('init-summary')) {
        summary.innerHTML = summary.innerHTML.replace(
            isHidden ? '\u25B6' : '\u25BC',
            isHidden ? '\u25BC' : '\u25B6'
        );
    }
}

function updateStats() {
    if (!program || !activeBackend) return;

    const counts = activeBackend.getStats(program);

    // Read timing values from inputs
    const timings = {};
    for (const instrType of Object.keys(activeBackend.timingDefaults)) {
        const el = document.getElementById('timing-' + instrType);
        timings[instrType] = el ? parseFloat(el.value) || 0 : 0;
    }

    document.getElementById('stats').innerHTML = activeBackend.formatStats(counts, timings);
}

// ============================================================
// Result Rendering (Expected Value Computation)
// ============================================================

function renderResult() {
    const numCols = bitWidth;
    const progName = document.getElementById('program').value;

    // Reconstruct output values
    let outputVals;
    if (activeBackend.reconstructOutput) {
        // Backend handles reconstruction (e.g. ReRAM reads specific cell positions)
        const outputRowNames = Object.keys(registers)
            .filter(r => r.startsWith('O'))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        outputVals = activeBackend.reconstructOutput(registers, outputRowNames, numCols, bitWidth);
    } else {
        // Default: Ambit-style vertical reconstruction from O* registers
        const outputRowNames = Object.keys(registers)
            .filter(r => r.startsWith('O'))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        const numOutputBits = outputRowNames.length;
        outputVals = [];
        for (let col = 0; col < numCols; col++) {
            let outVal = 0;
            let allNull = true;
            for (let bitPos = 0; bitPos < numOutputBits; bitPos++) {
                const vals = registers[outputRowNames[bitPos]];
                if (vals && vals[col] !== null) {
                    allNull = false;
                    if (vals[col] === 1) outVal |= (1 << bitPos);
                }
            }
            outputVals.push(allNull ? null : outVal);
        }
    }

    const inputData = parseInput(document.getElementById('inputVal').value);
    let inputArray, inputDisplay;

    if (typeof inputData === 'object' && inputData !== null && 'isNested' in inputData) {
        const operands = inputData.operands;
        const numCols2 = operands.length > 0 ? operands[0].length : 1;
        inputArray = [];
        for (let c = 0; c < numCols2; c++) {
            let val = 0;
            for (const op of operands) val += op[c] || 0;
            inputArray.push(val);
        }
        inputDisplay = document.getElementById('inputVal').value;
    } else if (Array.isArray(inputData)) {
        inputArray = inputData;
        inputDisplay = '[' + inputData.join(',') + ']';
    } else {
        inputArray = [inputData];
        inputDisplay = inputData;
    }

    const numOutputVals = outputVals.length;
    const numInputs = inputArray.length;
    // For backends with different #outputs vs #inputs, show all outputs
    const displayOutputs = numOutputVals > 0 ? outputVals : outputVals.slice(0, numInputs);

    // Detect signed output for sub
    const isSub = progName && (progName.startsWith('sub') || progName.toLowerCase().includes('subtractor'));
    let outputDisplay;
    if (isSub) {
        const maxSigned = bitWidth >= 32 ? 0x7FFFFFFF : (1 << (bitWidth - 1));
        outputDisplay = displayOutputs.map(v => {
            if (v === null) return '?';
            if (v > maxSigned) return v - (1 << bitWidth);
            return v;
        });
    } else {
        outputDisplay = displayOutputs.map(v => v === null ? '?' : v);
    }

    let expected = 'N/A';
    let correct = false;
    const isDone = pc >= program.instrs.length;

    if (isDone) {
        // Detect operation from program name or benchmark
        const opName = program.benchmark || progName || '';
        const result = computeExpected(opName, inputArray, displayOutputs, numInputs);
        expected = result.expected;
        correct = result.correct;
    }

    let resultHtml = `Input: ${inputDisplay} (${bitWidth}-bit)<br>`;
    resultHtml += `Output: [${outputDisplay.join(', ')}]<br>`;
    if (isDone) {
        resultHtml += `Expected: [${Array.isArray(expected) ? expected.join(', ') : expected}]`;
        if (correct) {
            resultHtml += '<br><span style="color:green;font-weight:bold;">CORRECT</span>';
        } else {
            resultHtml += '<br><span style="color:red;font-weight:bold;">WRONG</span>';
        }
    }
    document.getElementById('result').innerHTML = resultHtml;
}

// Compute expected values for known operations
function computeExpected(progName, inputArray, displayOutputs, numInputs) {
    const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
    const maxSigned = bitWidth >= 32 ? 0x7FFFFFFF : (1 << (bitWidth - 1));
    let expected = 'N/A';
    let correct = false;

    // Normalise: also match SIMPLER-MAGIC benchmark names like "abs_8bit_32"
    const pn = progName.toLowerCase();

    if (pn.startsWith('abs')) {
        let allCorrect = true;
        expected = [];
        for (let i = 0; i < numInputs; i++) {
            let val = inputArray[i];
            let signed = bitWidth >= 32 ? (val > maxSigned ? val - 0x100000000 : val)
                                        : (val > maxSigned ? val - (1 << bitWidth) : val);
            let exp = Math.abs(signed) & mask;
            if (bitWidth >= 32) exp = exp >>> 0;
            expected.push(exp);
            if (displayOutputs[i] !== exp) allCorrect = false;
        }
        correct = allCorrect;
    } else if (pn.startsWith('bitcount') || pn.startsWith('popcount')) {
        let allCorrect = true;
        expected = [];
        for (let i = 0; i < numInputs; i++) {
            const exp = inputArray[i].toString(2).split('1').length - 1;
            expected.push(exp);
            if (displayOutputs[i] !== exp) allCorrect = false;
        }
        correct = allCorrect;
    } else if (pn.startsWith('add')) {
        const result = computeBinaryOp('+', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('sub')) {
        const result = computeSubExpected();
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('mul')) {
        const result = computeBinaryOp('*', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('min')) {
        const result = computeBinaryOp('min', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('max')) {
        const result = computeBinaryOp('max', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('gt')) {
        const result = computeBinaryOp('>', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('ge')) {
        const result = computeBinaryOp('>=', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('eq')) {
        const result = computeBinaryOp('==', mask);
        expected = result.expected; correct = result.correct;
    } else if (pn.startsWith('ifelse')) {
        const result = computeIfelseExpected();
        expected = result.expected; correct = result.correct;
    }

    return { expected, correct };

    // Helper for binary operations parsed from nested input
    function computeBinaryOp(op, mask) {
        let allCorrect = true;
        const exp = [];
        const inputStr = document.getElementById('inputVal').value;
        if (inputStr.startsWith('[[') && inputStr.endsWith(']]')) {
            const operands = parseNestedOperands(inputStr);
            const numCols2 = operands.length > 0 ? operands[0].length : 1;
            for (let c = 0; c < numCols2; c++) {
                let val;
                const a = operands[0][c] || 0;
                const b = operands[1] ? (operands[1][c] || 0) : 0;
                switch (op) {
                    case '+': val = (a + b) & mask; break;
                    case '*': val = (a * b) & mask; break;
                    case 'min': val = Math.min(a, b); break;
                    case 'max': val = Math.max(a, b); break;
                    case '>': val = a > b ? 1 : 0; break;
                    case '>=': val = a >= b ? 1 : 0; break;
                    case '==': val = a === b ? 1 : 0; break;
                    default: val = 0;
                }
                if (bitWidth >= 32) val = val >>> 0;
                exp.push(val);
            }
            for (let c = 0; c < exp.length; c++) {
                if (displayOutputs[c] !== exp[c]) allCorrect = false;
            }
        }
        return { expected: exp, correct: allCorrect };
    }

    function computeSubExpected() {
        let allCorrect = true;
        const exp = [];
        const inputStr = document.getElementById('inputVal').value;
        if (inputStr.startsWith('[[') && inputStr.endsWith(']]')) {
            const operands = parseNestedOperands(inputStr);
            const numCols2 = operands.length > 0 ? operands[0].length : 1;
            for (let c = 0; c < numCols2; c++) {
                exp.push((operands[0][c] || 0) - (operands[1][c] || 0));
            }
            const displayOutputsSigned = displayOutputs.map(v => {
                if (v > maxSigned) return v - (1 << bitWidth);
                return v;
            });
            for (let c = 0; c < exp.length; c++) {
                if (displayOutputsSigned[c] !== exp[c]) allCorrect = false;
            }
        }
        return { expected: exp, correct: allCorrect };
    }

    function computeIfelseExpected() {
        let allCorrect = true;
        const exp = [];
        const inputStr = document.getElementById('inputVal').value;
        if (inputStr.startsWith('[[') && inputStr.endsWith(']]')) {
            const operands = parseNestedOperands(inputStr);
            const numCols2 = operands.length > 0 ? operands[0].length : 1;
            for (let c = 0; c < numCols2; c++) {
                const cond = operands[0][c] || 0;
                exp.push(cond ? (operands[1][c] || 0) : (operands[2] ? (operands[2][c] || 0) : 0));
            }
            for (let c = 0; c < exp.length; c++) {
                if (displayOutputs[c] !== exp[c]) allCorrect = false;
            }
        }
        return { expected: exp, correct: allCorrect };
    }
}

function parseNestedOperands(inputStr) {
    const inner = inputStr.slice(2, -2);
    return inner.split('],[').map(s => s.replace(/[\[\]]/g, '')).map(partsStr => {
        return partsStr.split(',').map(s => parseInt(s.trim(), 10) || 0);
    });
}

// ============================================================
// Scroll
// ============================================================

function scrollRows(delta) {
    scrollOffset += delta;
    render();
}
